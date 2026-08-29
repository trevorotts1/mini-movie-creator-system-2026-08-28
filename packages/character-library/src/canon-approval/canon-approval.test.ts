import { describe, expect, it } from "vitest";
import { ApprovalStore } from "@mmcs/core/approvals/approval-store.js";
import {
  approveAllProposedChanges,
  approveProposedCanonChange,
  canonForNextEpisode,
  describeCanonChange,
  generateCanonChangeId,
  listProposedCanonChanges,
  proposeEndOfEpisodeChanges,
  rejectProposedCanonChange,
  requireCanonGateApproved,
} from "./index.js";
import {
  CanonApprovalError,
  CanonGateNotApprovedError,
  CanonProposalInvalidError,
  DuplicateCanonChangeError,
} from "./errors.js";
import { createSeriesBible, addEpisodeSummary } from "../series-bible/bible.js";
import { currentCanon, canonAtEpisode } from "../series-bible/canon.js";
import type { SeriesBible } from "../series-bible/types.js";
import type { CanonGateSnapshot } from "./types.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_COLE_002";
const HARRIS = "CHAR_HARRIS_VAUGHN_003";

/** Seed a bible with pilot canon approved at v1 (cast + premise). */
function seedBible(): SeriesBible {
  const bible = createSeriesBible({
    seriesId: "SER_HARTWELL_HEIGHTS_001",
    title: "Hartwell Heights",
    premise: "A night-shift ER doctor keeps reliving the same rainy Tuesday.",
  });
  const list = proposeEndOfEpisodeChanges(bible, {
    episode: "S01E01",
    proposedAt: "2026-08-01T00:00:00Z",
    drafts: [
      {
        changeId: "CC_S01E01_001",
        description: "Pilot cast",
        mutations: [
          { op: "add_character", link: { characterId: MONICA, role: "lead" } },
          { op: "add_character", link: { characterId: MARCUS, role: "recurring" } },
        ],
      },
    ],
  });
  expect(list.entries).toHaveLength(1);
  approveProposedCanonChange(bible, "CC_S01E01_001", {
    gate: approvedGate(),
    decidedAt: "2026-08-01T01:00:00Z",
  });
  return bible;
}

/** An operator-approved canon gate snapshot (CORE-008 shape). */
function approvedGate(overrides?: Partial<CanonGateSnapshot>): CanonGateSnapshot {
  return {
    gate: "canon",
    state: "APPROVED",
    approvedAt: "2026-08-10T12:00:00Z",
    rejectedAt: null,
    decidedBy: "trevor",
    note: "approved end-of-episode canon",
    ...overrides,
  };
}

/** The spec §10 end-of-episode example facts for S01E09. */
function endOfEpisodeDrafts() {
  return [
    {
      description: "Marcus broke his arm",
      mutations: [
        {
          op: "record_character_event" as const,
          event: {
            characterId: MARCUS,
            event: "broke his arm",
            effectiveEpisode: "S01E09",
          },
        },
      ],
    },
    {
      description: "Monica changed hairstyle",
      mutations: [
        {
          op: "add_wardrobe" as const,
          wardrobe: { characterId: MONICA, wardrobeVersion: "short-hair-v2" },
        },
      ],
    },
  ];
}

describe("proposeEndOfEpisodeChanges — Proposed Canon Changes list", () => {
  it("stages PROPOSED changes and returns the review list without touching canon", () => {
    const bible = seedBible();
    const before = currentCanon(bible);

    const list = proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });

    expect(list.seriesId).toBe("SER_HARTWELL_HEIGHTS_001");
    expect(list.episode).toBe("S01E09");
    expect(list.proposedAt).toBe("2026-08-10T00:00:00Z");
    expect(list.entries).toHaveLength(2);
    expect(list.entries[0]?.change.changeId).toBe("CC_S01E09_001");
    expect(list.entries[1]?.change.changeId).toBe("CC_S01E09_002");
    for (const entry of list.entries) {
      expect(entry.change.status).toBe("PROPOSED");
      expect(entry.change.effectiveEpisode).toBe("S01E09");
      expect(entry.change.proposedAt).toBe("2026-08-10T00:00:00Z");
    }
    // Canon untouched: no permanent update without approval.
    expect(currentCanon(bible)).toEqual(before);
    expect(currentCanon(bible).characterEvents).toHaveLength(0);
    expect(canonAtEpisode(bible, "S01E09").wardrobe).toHaveLength(0);
  });

  it("derives change IDs and descriptions when drafts omit them", () => {
    const bible = seedBible();
    const list = proposeEndOfEpisodeChanges(bible, {
      episode: "S01E02",
      proposedAt: "2026-08-02T00:00:00Z",
      drafts: [
        {
          mutations: [
            { op: "add_prop", prop: { propId: "PROP_PAGER_001", name: "Monica's pager" } },
          ],
        },
      ],
    });
    expect(list.entries[0]?.change.changeId).toBe("CC_S01E02_001");
    expect(list.entries[0]?.change.description).toBe(
      "1 canon mutation: add_prop",
    );
  });

  it("carries proposal provenance onto the review entries", () => {
    const bible = seedBible();
    const list = proposeEndOfEpisodeChanges(bible, {
      episode: "S01E03",
      proposedAt: "2026-08-03T00:00:00Z",
      drafts: [
        {
          mutations: [{ op: "set_premise", premise: "Same rainy Tuesday." }],
          source: { observedFrom: "episode-summary", evidence: "the loop continues" },
        },
      ],
    });
    expect(list.entries[0]?.source?.observedFrom).toBe("episode-summary");
    expect(list.entries[0]?.source?.evidence).toBe("the loop continues");
  });

  it("rejects empty batches, empty mutations, and bad timestamps before staging", () => {
    const bible = seedBible();
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E04",
        proposedAt: "2026-08-04T00:00:00Z",
        drafts: [],
      }),
    ).toThrow(CanonApprovalError);
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E04",
        proposedAt: "2026-08-04T00:00:00Z",
        drafts: [{ mutations: [] }],
      }),
    ).toThrow(CanonApprovalError);
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E04",
        proposedAt: "not-a-timestamp",
        drafts: endOfEpisodeDrafts(),
      }),
    ).toThrow(CanonApprovalError);
    expect(bible.canonChanges).toHaveLength(1);
  });

  it("rejects duplicate change IDs — within the batch and against the ledger", () => {
    const bible = seedBible();
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E05",
        proposedAt: "2026-08-05T00:00:00Z",
        drafts: [
          { changeId: "CC_S01E05_001", mutations: [{ op: "set_premise", premise: "a" }] },
          { changeId: "CC_S01E05_001", mutations: [{ op: "set_premise", premise: "b" }] },
        ],
      }),
    ).toThrow(DuplicateCanonChangeError);
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E05",
        proposedAt: "2026-08-05T00:00:00Z",
        drafts: [{ changeId: "CC_S01E01_001", mutations: [{ op: "set_premise", premise: "a" }] }],
      }),
    ).toThrow(DuplicateCanonChangeError);
  });

  it("dry-runs the batch: an invalid draft stages NOTHING and names the offender", () => {
    const bible = seedBible();
    // Resolving an unknown plot thread fails approval validation — and the
    // valid draft beside it must not be staged either (atomic batch).
    expect(() =>
      proposeEndOfEpisodeChanges(bible, {
        episode: "S01E06",
        proposedAt: "2026-08-06T00:00:00Z",
        drafts: [
          {
            mutations: [{ op: "add_prop", prop: { propId: "PROP_CUP_001", name: "paper cup" } }],
          },
          {
            mutations: [
              {
                op: "resolve_plot_thread",
                threadId: "THREAD_MISSING",
                resolvedEpisode: "S01E06",
              },
            ],
          },
        ],
      }),
    ).toThrow(CanonProposalInvalidError);
    expect(bible.canonChanges).toHaveLength(1);
  });
});

describe("Gate 6 — no permanent canon update without approval", () => {
  it("throws when the canon gate is PENDING", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const pendingGate: CanonGateSnapshot = {
      gate: "canon",
      state: "PENDING",
      approvedAt: null,
      rejectedAt: null,
      decidedBy: null,
      note: null,
    };
    expect(() =>
      approveProposedCanonChange(bible, "CC_S01E09_001", {
        gate: pendingGate,
        decidedAt: "2026-08-10T01:00:00Z",
      }),
    ).toThrow(CanonGateNotApprovedError);
    expect(bible.canonChanges.find((c) => c.changeId === "CC_S01E09_001")?.status).toBe(
      "PROPOSED",
    );
    expect(currentCanon(bible).characterEvents).toHaveLength(0);
  });

  it("throws when a non-canon gate snapshot is presented", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    expect(() =>
      approveProposedCanonChange(bible, "CC_S01E09_001", {
        gate: approvedGate({ gate: "rough-cut" }),
        decidedAt: "2026-08-10T01:00:00Z",
      }),
    ).toThrow(CanonApprovalError);
  });

  it("accepts the real CORE-008 store snapshot (structural, read-only)", async () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const store = new ApprovalStore("/tmp/char013-approvals-canonical");
    await store.load();
    // Gate not yet approved: the snapshot blocks approval.
    const snapshot = await store.snapshot("canon");
    expect(() =>
      approveProposedCanonChange(bible, "CC_S01E09_001", {
        gate: snapshot,
        decidedAt: "2026-08-10T01:00:00Z",
      }),
    ).toThrow(CanonGateNotApprovedError);
  });
});

describe("approval — approved proposals create new versions", () => {
  it("stamps sequential canonVersions and applies mutations", () => {
    const bible = seedBible(); // v1 = pilot
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const v2 = approveProposedCanonChange(bible, "CC_S01E09_001", {
      gate: approvedGate(),
      decidedAt: "2026-08-10T01:00:00Z",
    });
    expect(v2.canonVersion).toBe(2);
    expect(v2.status).toBe("APPROVED");
    expect(v2.decidedAt).toBe("2026-08-10T01:00:00Z");
    const v3 = approveProposedCanonChange(bible, "CC_S01E09_002", {
      gate: approvedGate(),
      decidedAt: "2026-08-10T01:05:00Z",
    });
    expect(v3.canonVersion).toBe(3);
    // Permanent canon now carries the approved facts.
    const live = currentCanon(bible);
    expect(live.characterEvents.some((e) => e.event === "broke his arm")).toBe(true);
    expect(live.wardrobe.some((w) => w.wardrobeVersion === "short-hair-v2")).toBe(true);
  });

  it("keeps historical episodes at canon-at-the-time after approval", () => {
    const bible = seedBible();
    addEpisodeSummary(bible, { episode: "S01E08", summary: "Marcus, two arms." });
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: [
        {
          mutations: [
            {
              op: "record_character_event",
              event: { characterId: MARCUS, event: "broke his arm", effectiveEpisode: "S01E09" },
            },
          ],
        },
      ],
    });
    approveProposedCanonChange(bible, "CC_S01E09_001", {
      gate: approvedGate(),
      decidedAt: "2026-08-10T01:00:00Z",
    });
    // E09 canon has the event; E08 canon never does.
    expect(
      canonAtEpisode(bible, "S01E09").characterEvents.some((e) => e.event === "broke his arm"),
    ).toBe(true);
    expect(canonAtEpisode(bible, "S01E08").characterEvents).toHaveLength(0);
  });

  it("approveAllProposedChanges approves the batch atomically in proposal order", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const approved = approveAllProposedChanges(bible, {
      gate: approvedGate(),
      decidedAt: "2026-08-10T02:00:00Z",
    });
    expect(approved.map((c) => c.canonVersion)).toEqual([2, 3]);
    expect(
      bible.canonChanges.filter((c) => c.status === "PROPOSED"),
    ).toHaveLength(0);
  });

  it("approveAllProposedChanges leaves everything PROPOSED when one change is invalid", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: [
        {
          // Valid against the current bible...
          mutations: [
            { op: "add_character", link: { characterId: HARRIS, role: "recurring" } },
          ],
        },
      ],
    });
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E10",
      proposedAt: "2026-08-11T00:00:00Z",
      drafts: [
        {
          // ...and so is this batch alone — but approving EVERYTHING in one
          // pass approves HARRIS first, so this duplicate add must fail and
          // leave every change PROPOSED.
          mutations: [
            { op: "add_character", link: { characterId: HARRIS, role: "recurring" } },
          ],
        },
      ],
    });
    expect(() =>
      approveAllProposedChanges(bible, {
        gate: approvedGate(),
        decidedAt: "2026-08-11T01:00:00Z",
      }),
    ).toThrow(CanonProposalInvalidError);
    // Nothing approved: no version stamped past v1.
    expect(
      bible.canonChanges.filter((c) => c.canonVersion !== undefined),
    ).toHaveLength(1);
  });

  it("approveAllProposedChanges throws on an empty selection", () => {
    const bible = seedBible();
    expect(() =>
      approveAllProposedChanges(bible, {
        gate: approvedGate(),
        decidedAt: "2026-08-10T02:00:00Z",
      }),
    ).toThrow(CanonApprovalError);
  });
});

describe("rejection — terminal, needs no gate, touches no canon", () => {
  it("rejects one proposal and keeps canon unchanged", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const rejected = rejectProposedCanonChange(
      bible,
      "CC_S01E09_001",
      "2026-08-10T03:00:00Z",
    );
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.decidedAt).toBe("2026-08-10T03:00:00Z");
    expect(rejected.canonVersion).toBeUndefined();
    expect(currentCanon(bible).characterEvents).toHaveLength(0);
    // Remaining proposal still lists; rejected one does not.
    const pending = listProposedCanonChanges(bible);
    expect(pending.map((e) => e.change.changeId)).toEqual(["CC_S01E09_002"]);
  });
});

describe("review helpers", () => {
  it("listProposedCanonChanges orders by effective episode and filters", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E08",
      proposedAt: "2026-08-09T00:00:00Z",
      drafts: [
        {
          changeId: "CC_S01E08_001",
          mutations: [{ op: "set_premise", premise: "The loop tightens." }],
        },
      ],
    });
    const all = listProposedCanonChanges(bible);
    expect(all.map((e) => e.change.effectiveEpisode)).toEqual([
      "S01E08",
      "S01E09",
      "S01E09",
    ]);
    const e09 = listProposedCanonChanges(bible, { episode: "S01E09" });
    expect(e09).toHaveLength(2);
  });

  it("generateCanonChangeId increments per episode", () => {
    const bible = seedBible();
    expect(generateCanonChangeId(bible, "S01E09")).toBe("CC_S01E09_001");
    const list = proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    expect(list.entries[0]?.change.changeId).toBe("CC_S01E09_001");
    expect(generateCanonChangeId(bible, "S01E09")).toBe("CC_S01E09_003");
  });

  it("describeCanonChange summarizes ops with counts", () => {
    expect(describeCanonChange([{ op: "set_premise", premise: "x" }])).toBe(
      "1 canon mutation: set_premise",
    );
    expect(
      describeCanonChange([
        { op: "add_character", link: { characterId: "A", role: "lead" } },
        { op: "add_character", link: { characterId: "B", role: "recurring" } },
        { op: "set_premise", premise: "x" },
      ]),
    ).toBe("3 canon mutations: add_character ×2, set_premise");
  });

  it("requireCanonGateApproved passes only an APPROVED canon gate", () => {
    expect(requireCanonGateApproved(approvedGate()).state).toBe("APPROVED");
    expect(() => requireCanonGateApproved(approvedGate({ gate: "script" }))).toThrow(
      CanonApprovalError,
    );
    expect(() =>
      requireCanonGateApproved(approvedGate({ state: "REJECTED", approvedAt: null })),
    ).toThrow(CanonGateNotApprovedError);
  });
});

describe("canonForNextEpisode — production read", () => {
  it("separates approved canon from pending proposals", () => {
    const bible = seedBible();
    proposeEndOfEpisodeChanges(bible, {
      episode: "S01E09",
      proposedAt: "2026-08-10T00:00:00Z",
      drafts: endOfEpisodeDrafts(),
    });
    const view = canonForNextEpisode(bible);
    expect(view.approved.premise).toContain("rainy Tuesday");
    expect(view.approved.characterEvents).toHaveLength(0);
    expect(view.pending.map((e) => e.change.changeId)).toEqual([
      "CC_S01E09_001",
      "CC_S01E09_002",
    ]);
  });
});
