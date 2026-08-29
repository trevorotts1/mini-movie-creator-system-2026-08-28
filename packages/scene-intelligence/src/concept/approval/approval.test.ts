/**
 * Concept-approval gate tests — DIR-003.
 *
 * Acceptance: "no screenplay work while concept unapproved (state throws)".
 * Two hard-stop layers are pinned:
 *   1. `requireConceptApproved` — the approval module's own gate; PENDING and
 *      REJECTED states throw ConceptApprovalRequiredError, APPROVED passes;
 *   2. `generateScreenplay` (DIR-004) — called with a record built through
 *      THIS gate only when the gate approved; unapproved decisions never
 *      produce a record the generator accepts.
 *
 * The CORE-008 `ApprovalStore` (real durable store) is used directly in the
 * store-drop-in tests — proving the structural port needs no adapter.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Real durable gate store (CORE-008) — the production port implementation.
import { ApprovalStore } from "@mmcs/core/approvals/approval-store.js";
import { GATE_IDS } from "@mmcs/core/approvals/gates.js";

// Downstream gate-1 consumer (DIR-004): the thing that must NOT run unapproved.
import { generateScreenplay, ConceptNotApprovedError } from "@mmcs/scene-intelligence/screenplay/generator.js";

import {
  applyConceptDecision,
  buildApprovedConceptRecord,
  CONCEPT_GATE_ID,
  isConceptApproved,
  requireConceptApproved,
  resolveSelectedOptionId,
  selectOptionFields,
} from "./approve.js";
import { requireConceptDraft } from "./draft.js";
import {
  ConceptApprovalRequiredError,
  ConceptGateError,
  type ConceptBridgeInput,
  type ConceptDraftInput,
  type GateSnapshotView,
} from "./types.js";

const CONCEPT_ID = "concept_" + "a".repeat(32);
const INTAKE_ID = "idea_" + "b".repeat(32);

function draftFixture(): ConceptDraftInput {
  return {
    conceptId: CONCEPT_ID,
    intakeId: INTAKE_ID,
    options: [
      { optionId: "option_1", title: "The Signal in the Beam" },
      { optionId: "option_2", title: "Tidefall" },
      { optionId: "option_3", title: "Lampfall Bay" },
    ],
    recommendedOptionId: "option_1",
  };
}

function bridgeFixture(): ConceptBridgeInput {
  return {
    ...draftFixture(),
    targetRuntimeSeconds: 480,
    aspectRatio: "16:9",
    options: [
      {
        optionId: "option_1",
        title: "The Signal in the Beam",
        logline: "A cat decodes light from the future and must stop the storm it foretells.",
        premise: "A coastal lighthouse where the lamp spells out warnings.",
        genre: "Mystery",
        tone: "warm and eerie",
        suggestedRuntimeSeconds: null,
        suggestedAspectRatio: null,
      },
      {
        optionId: "option_2",
        title: "Tidefall",
        logline: "The sea recedes one night and only the animals remember it came back.",
        premise: "An empty seabed and an upside-down drowned city.",
        genre: "Adventure",
        tone: "playful wonder",
        suggestedRuntimeSeconds: 300,
        suggestedAspectRatio: "9:16",
      },
      { optionId: "option_3", title: "Lampfall Bay" },
    ],
  };
}

/** Real durable store on a fresh temp dir (the drop-in port implementation). */
function realStore(): ApprovalStore {
  return new ApprovalStore(mkdtempSync(join(tmpdir(), "mmcs-dir003-")));
}

describe("CONCEPT_GATE_ID", () => {
  it("is spec §3 gate 1 and matches the CORE-008 gate id", () => {
    expect(CONCEPT_GATE_ID).toBe("concept");
    expect(GATE_IDS[0]).toBe("concept");
  });
});

describe("requireConceptDraft — draft validation", () => {
  it("accepts a well-formed draft", () => {
    expect(() => requireConceptDraft(draftFixture())).not.toThrow();
  });

  it("rejects a recommendedOptionId outside the presented options", () => {
    const draft = { ...draftFixture(), recommendedOptionId: "option_9" };
    expect(() => requireConceptDraft(draft)).toThrow(ConceptGateError);
  });

  it("rejects duplicate option ids", () => {
    const draft = draftFixture();
    const bad = { ...draft, options: [draft.options[0]!, draft.options[0]!] };
    expect(() => requireConceptDraft(bad)).toThrow(/duplicate/);
  });

  it("rejects malformed concept/intake ids", () => {
    expect(() =>
      requireConceptDraft({ ...draftFixture(), conceptId: "c-1" }),
    ).toThrow(/concept_/);
    expect(() =>
      requireConceptDraft({ ...draftFixture(), intakeId: "not-an-intake" }),
    ).toThrow(/idea_/);
  });

  it("rejects more than the 5-option generator maximum", () => {
    const options = [1, 2, 3, 4, 5, 6].map((n) => ({
      optionId: `option_${n}`,
      title: `Option ${n}`,
    }));
    expect(() =>
      requireConceptDraft({ ...draftFixture(), options }),
    ).toThrow(/5/);
  });
});

describe("requireConceptApproved — gate 1 hard stop (state throws)", () => {
  it("throws ConceptApprovalRequiredError while PENDING (real store, fresh boot)", async () => {
    const store = realStore();
    await expect(requireConceptApproved(store)).rejects.toBeInstanceOf(
      ConceptApprovalRequiredError,
    );
    await expect(requireConceptApproved(store)).rejects.toThrow(/PENDING/);
  });

  it("throws after REJECTED — a rejected concept still blocks screenplay work", async () => {
    const store = realStore();
    await store.reject("concept", { note: "needs a stronger hook" });
    await expect(requireConceptApproved(store)).rejects.toThrow(/REJECTED/);
  });

  it("passes once APPROVED and returns the approval snapshot", async () => {
    const store = realStore();
    await store.approve("concept", { decidedBy: "trevor" });
    const snapshot = await requireConceptApproved(store);
    expect(snapshot.state).toBe("APPROVED");
    expect(snapshot.gate).toBe("concept");
    expect(snapshot.approvedAt).not.toBeNull();
    expect(snapshot.decidedBy).toBe("trevor");
    expect(await isConceptApproved(store)).toBe(true);
  });

  it("mirrors reopen: APPROVED → PENDING blocks again", async () => {
    const store = realStore();
    await store.approve("concept");
    await store.reopen("concept");
    await expect(requireConceptApproved(store)).rejects.toThrow(/PENDING/);
    expect(await isConceptApproved(store)).toBe(false);
  });
});

describe("applyConceptDecision — decision application over the real store", () => {
  it("approve: persists APPROVED and mirrors decidedAt/decidedBy/note", async () => {
    const store = realStore();
    const { record, snapshot } = await applyConceptDecision(
      "approve",
      draftFixture(),
      store,
      { decidedBy: "trevor", note: "option 1 it is" },
    );
    expect(record.decision).toBe("APPROVED");
    expect(record.decidedAt).toBe(snapshot.approvedAt);
    expect(record.decidedBy).toBe("trevor");
    expect(record.note).toBe("option 1 it is");
    expect(record.schemaVersion).toBe("concept-approval.schema/v1");
    expect(record.selectedOptionId).toBe("option_1"); // recommendation default
    // durable: a fresh store instance over the same dir reads APPROVED
    const persisted = new ApprovalStore(store.dir);
    expect((await persisted.snapshot("concept")).state).toBe("APPROVED");
  });

  it("reject: records REJECTED with the operator note, keeps options listed", async () => {
    const store = realStore();
    const { record } = await applyConceptDecision(
      "reject",
      draftFixture(),
      store,
      { note: "try a smaller cast" },
    );
    expect(record.decision).toBe("REJECTED");
    expect(record.note).toBe("try a smaller cast");
    expect(record.decidedAt).toBeNull();
    expect(record.options).toHaveLength(3);
  });

  it("approve is idempotent-blocked: APPROVED → APPROVED throws (store state machine)", async () => {
    const store = realStore();
    await applyConceptDecision("approve", draftFixture(), store);
    await expect(
      applyConceptDecision("approve", draftFixture(), store),
    ).rejects.toThrow(/illegal gate transition/);
  });

  it("reopen then re-approve presents revised work again", async () => {
    const store = realStore();
    await applyConceptDecision("reject", draftFixture(), store);
    await applyConceptDecision("reopen", draftFixture(), store);
    const { record } = await applyConceptDecision("approve", draftFixture(), store);
    expect(record.decision).toBe("APPROVED");
  });

  it("explicit selectedOptionId overrides the recommendation", async () => {
    const store = realStore();
    const { record } = await applyConceptDecision(
      "approve",
      draftFixture(),
      store,
      {},
      { selectedOptionId: "option_2" },
    );
    expect(record.selectedOptionId).toBe("option_2");
  });

  it("unknown selectedOptionId is refused before the store is touched", async () => {
    const store = realStore();
    await expect(
      applyConceptDecision("approve", draftFixture(), store, {}, {
        selectedOptionId: "option_99",
      }),
    ).rejects.toThrow(/does not name a presented option/);
    expect((await store.snapshot("concept")).state).toBe("PENDING");
  });

  it("rejects an unknown action (exhaustive switch)", async () => {
    const store = realStore();
    await expect(
      applyConceptDecision(
        "detonate" as "approve" | "reject" | "reopen",
        draftFixture(),
        store,
      ),
    ).rejects.toThrow(/unknown concept-gate action/);
  });

  it("resolveSelectedOptionId: null/undefined falls back to the recommendation", () => {
    const draft = draftFixture();
    expect(resolveSelectedOptionId(draft, null)).toBe("option_1");
    expect(resolveSelectedOptionId(draft, undefined)).toBe("option_1");
    expect(resolveSelectedOptionId(draft, "option_3")).toBe("option_3");
    expect(() => resolveSelectedOptionId(draft, "option_7")).toThrow(
      ConceptGateError,
    );
  });
});

describe("buildApprovedConceptRecord — bridge to DIR-004", () => {
  it("refuses a non-APPROVED decision record", () => {
    const store = realStore();
    // A record built from a PENDING snapshot (no store mutation) must refuse.
    const record = {
      schemaVersion: "concept-approval.schema/v1",
      conceptId: CONCEPT_ID,
      intakeId: INTAKE_ID,
      options: draftFixture().options,
      selectedOptionId: "option_1",
      decision: "PENDING",
      decidedAt: null,
      decidedBy: null,
      note: null,
      draftedAt: "2026-08-28T10:00:00.000Z",
    } as const;
    expect(() => buildApprovedConceptRecord(bridgeFixture(), record)).toThrow(
      ConceptApprovalRequiredError,
    );
    void store;
  });

  it("projects the APPROVED decision into the DIR-004 ApprovedConcept shape", async () => {
    const store = realStore();
    const { record } = await applyConceptDecision(
      "approve",
      draftFixture(),
      store,
      { decidedBy: "trevor" },
      { selectedOptionId: "option_1" },
    );
    const bridge = buildApprovedConceptRecord(bridgeFixture(), record);
    expect(bridge.approval.state).toBe("APPROVED");
    expect(bridge.approval.selectedOptionId).toBe("option_1");
    expect(bridge.conceptId).toBe(CONCEPT_ID);
    expect(bridge.title).toBe("The Signal in the Beam");
    expect(bridge.tone).toBe("warm and eerie");
    expect(bridge.targetRuntimeSeconds).toBe(480); // falls back to intake default
    expect(bridge.aspectRatio).toBe("16:9");
  });

  it("honors the selected option's runtime/aspect overrides", async () => {
    const store = realStore();
    const { record } = await applyConceptDecision(
      "approve",
      draftFixture(),
      store,
      {},
      { selectedOptionId: "option_2" },
    );
    const bridge = buildApprovedConceptRecord(bridgeFixture(), record);
    expect(bridge.targetRuntimeSeconds).toBe(300);
    expect(bridge.aspectRatio).toBe("9:16");
  });
});

describe("gate 1 → DIR-004 screenplay hard stop (acceptance)", () => {
  it("an approved-concept record generated THROUGH the gate feeds generateScreenplay", async () => {
    const store = realStore();
    const { record } = await applyConceptDecision(
      "approve",
      draftFixture(),
      store,
      { decidedBy: "trevor" },
      { selectedOptionId: "option_1" },
    );
    const concept = buildApprovedConceptRecord(bridgeFixture(), record);
    const writer = {
      complete: async () => ({
        text: JSON.stringify({
          title: "The Signal in the Beam",
          logline: concept.logline,
          scenes: [
            {
              heading: "INT. LIGHTHOUSE - NIGHT",
              synopsis: "Mira watches the lamp spell a warning.",
              timeOfDay: "NIGHT",
              dialogue: [
                { characterName: "Mira", text: "The light is talking." },
              ],
            },
          ],
          characters: [
            {
              name: "Mira",
              role: "lead",
              description: "The lighthouse cat.",
              isNew: true,
            },
          ],
        }),
      }),
    };
    const screenplay = await generateScreenplay(concept, writer, {
      now: () => "2026-08-28T10:00:00.000Z",
    });
    expect(screenplay.conceptId).toBe(CONCEPT_ID);
    // Gate-1 evidence rides on the bridge record's approval block (the
    // Screenplay record itself stamps provenance in metadata).
    expect(concept.approval.state).toBe("APPROVED");
    expect(concept.approval.selectedOptionId).toBe("option_1");
    expect(screenplay.metadata.schemaVersion).toBe("screenplay.schema/v1");
    expect(screenplay.scenes.length).toBeGreaterThan(0);
  });

  it("a concept that never went through the gate cannot be shaped for the writer", async () => {
    // Without a decision there is no record: the only route to the generator
    // is buildApprovedConceptRecord, which refuses non-APPROVED mirrors. The
    // generator itself rejects a hand-forged PENDING record.
    const forged = {
      conceptId: CONCEPT_ID,
      title: "Forged",
      logline: "No gate.",
      idea: "none",
      characters: [],
      setting: "nowhere",
      tone: "flat",
      targetRuntimeSeconds: 60,
      aspectRatio: "16:9",
      approval: { state: "PENDING" as const },
    };
    await expect(generateScreenplay(forged, { complete: async () => ({ text: "{}" }) }))
      .rejects.toBeInstanceOf(ConceptNotApprovedError);
  });
});

describe("selectOptionFields — presentation helper", () => {
  it("returns the full creative fields for the selected option", () => {
    const fields = selectOptionFields(bridgeFixture().options, "option_2");
    expect(fields?.title).toBe("Tidefall");
    expect(fields?.suggestedRuntimeSeconds).toBe(300);
  });

  it("yields undefined for an unknown option id", () => {
    expect(selectOptionFields(bridgeFixture().options, "option_9")).toBeUndefined();
  });
});

describe("store drop-in proof — CORE-008 ApprovalStore satisfies the port", () => {
  it("structural conformance: snapshot/approve/reject/reopen match the port shape", async () => {
    const store: import("./types.js").ApprovalGateStorePort = realStore();
    const snap: GateSnapshotView = await store.snapshot("concept");
    expect(snap.state).toBe("PENDING");
    const approved = await store.approve("concept", { decidedBy: "trevor" });
    expect(approved.state).toBe("APPROVED");
  });
});
