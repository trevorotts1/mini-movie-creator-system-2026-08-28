/// <reference types="node" />
// QC-011 acceptance tests — human REVIEW state (spec §20).
//
// Acceptance: automated routes exhausted → shot enters a PERSISTED human
// REVIEW state; NO SILENT AUTO-APPROVAL; `mmcs qc` surfaces REVIEW items
// (listReviews is the engine-side surface the command reads).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HUMAN_REVIEW_FILE,
  HUMAN_REVIEW_SCHEMA_VERSION,
  HUMAN_REVIEW_STATES,
  HUMAN_REVIEW_TRIGGERS,
  HumanReviewStore,
  HumanReviewStoreError,
  LEGAL_HUMAN_REVIEW_TRANSITIONS,
  decideHumanReview,
  emptyHumanReviewDocument,
  normalizeHumanReviewDocument,
  type HumanReviewEntryInput,
  type MarkReviewInput,
} from "./index.js";

let dir: string;
let seq = 0;

/** Injectable clock: deterministic, strictly increasing ISO timestamps. */
function tick(): string {
  seq += 1;
  return `2026-08-29T00:00:${String(seq).padStart(2, "0")}.000Z`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mmcs-human-review-"));
  seq = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<HumanReviewEntryInput> = {}): HumanReviewEntryInput {
  return {
    shotId: "S01E01_SC04_SH07",
    episodeId: "S01E01",
    ...overrides,
  };
}

function markInput(overrides: Partial<MarkReviewInput> = {}): MarkReviewInput {
  return {
    shotId: "S01E01_SC04_SH07",
    episodeId: "S01E01",
    trigger: "routes-exhausted",
    reason: "flash → regular → seedance → wan all failed",
    routesTried: ["agnes-flash", "agnes-regular", "seedance", "wan"],
    ...overrides,
    now: overrides.now ?? tick(),
  };
}

describe("decideHumanReview — entry decisions (spec §20)", () => {
  it("enters REVIEW when the retry ladder exhausts every automated route", () => {
    const d = decideHumanReview(
      entry({
        repairAction: "review",
        routesTried: ["agnes-flash", "agnes-regular", "seedance", "wan"],
      }),
    );
    expect(d).toEqual({
      enter: true,
      trigger: "routes-exhausted",
      reason: expect.stringContaining("agnes-flash → agnes-regular → seedance → wan"),
    });
  });

  it("enters REVIEW on a QC verdict of REVIEW (reviewer flagged human judgment)", () => {
    const d = decideHumanReview(entry({ qcVerdict: "REVIEW", repairAction: "regenerate" }));
    expect(d.enter).toBe(true);
    expect(d.trigger).toBe("qc-verdict-review");
  });

  it("enters REVIEW when no automated review route is available (QC-005 unavailable)", () => {
    const d = decideHumanReview(
      entry({ reviewRoute: "unavailable", qcVerdict: "FAIL", repairAction: "review" }),
    );
    expect(d.enter).toBe(true);
    // Verdict REVIEW outranks the route signal — either trigger is legal;
    // with no REVIEW verdict the unavailable route decides.
    expect(["qc-verdict-review", "review-unavailable"]).toContain(d.trigger);
  });

  it("unavailable route without a REVIEW verdict enters via review-unavailable", () => {
    const d = decideHumanReview(entry({ reviewRoute: "unavailable", qcVerdict: "FAIL" }));
    expect(d.enter).toBe(true);
    expect(d.trigger).toBe("review-unavailable");
  });

  it("never enters REVIEW on PASS — even when the stale ladder also says review", () => {
    const d = decideHumanReview(entry({ qcVerdict: "PASS", repairAction: "review" }));
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/PASS/);
  });

  it("FAIL with routes left stays with the automated repair loop (no premature review)", () => {
    const d = decideHumanReview(entry({ qcVerdict: "FAIL", repairAction: "regenerate" }));
    expect(d.enter).toBe(false);
    expect(d.trigger).toBeNull();
  });

  it("awaiting-approval is a budget hold, not a review item", () => {
    const d = decideHumanReview(entry({ repairAction: "awaiting-approval" }));
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/spend policy/);
  });

  it("no exhaustion signal at all keeps the shot with the pipeline", () => {
    const d = decideHumanReview(entry({}));
    expect(d).toEqual({ enter: false, trigger: null, reason: expect.any(String) });
  });

  it("throws on blank shotId/episodeId — an unidentified shot never enters review", () => {
    expect(() => decideHumanReview(entry({ shotId: "  " }))).toThrow(/shotId/);
    expect(() => decideHumanReview(entry({ episodeId: "" }))).toThrow(/episodeId/);
  });
});

describe("HumanReviewStore — persistence (spec §3 discipline)", () => {
  it("markReview persists immediately: the record survives store recreation", async () => {
    const first = new HumanReviewStore(dir);
    await first.markReview(markInput());

    // Simulate a process restart: brand-new store over the same directory.
    const second = new HumanReviewStore(dir);
    const snapshot = await second.snapshot("S01E01_SC04_SH07");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.state).toBe("REVIEW");
    expect(snapshot?.trigger).toBe("routes-exhausted");
    expect(snapshot?.enteredAt).toBe("2026-08-29T00:00:01.000Z");
    // The file itself exists on disk with the schema version.
    const raw = JSON.parse(await readFile(join(dir, HUMAN_REVIEW_FILE), "utf8"));
    expect(raw.schemaVersion).toBe(HUMAN_REVIEW_SCHEMA_VERSION);
    expect(raw.reviews.S01E01_SC04_SH07.state).toBe("REVIEW");
  });

  it("an empty project has zero open reviews and reads as an empty document", async () => {
    const store = new HumanReviewStore(dir);
    expect(await store.openCount()).toBe(0);
    expect(await store.listReviews()).toEqual([]);
    expect((await store.get()).reviews).toEqual({});
  });

  it("refreshing a REVIEW record preserves the original enteredAt (parked-since is stable)", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput({ now: tick() }));
    await store.markReview(
      markInput({ attempt: 2, reason: "failed again after wan", now: tick() }),
    );
    const rec = await store.snapshot("S01E01_SC04_SH07");
    expect(rec?.enteredAt).toBe("2026-08-29T00:00:01.000Z");
    expect(rec?.updatedAt).toBe("2026-08-29T00:00:02.000Z");
    expect(rec?.attempt).toBe(2);
    expect(rec?.state).toBe("REVIEW");
  });
});

describe("HumanReviewStore — NO SILENT AUTO-APPROVAL", () => {
  it("approve without decidedBy is refused — nothing is written", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    await expect(
      store.approve("S01E01_SC04_SH07", { decidedBy: "" }),
    ).rejects.toThrow(/requires decidedBy/);
    await expect(
      store.approve("S01E01_SC04_SH07", { decidedBy: "   " }),
    ).rejects.toThrow(/requires decidedBy/);
    // Still REVIEW on disk — the refusal left no trace of an approval.
    const second = new HumanReviewStore(dir);
    expect((await second.snapshot("S01E01_SC04_SH07"))?.state).toBe("REVIEW");
  });

  it("approve with decidedBy records the human, the instant, and the note", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    const rec = await store.approve("S01E01_SC04_SH07", {
      decidedBy: "trevor",
      note: "flash footage reads fine at 720p",
      now: tick(),
    });
    expect(rec.state).toBe("APPROVED");
    expect(rec.decidedBy).toBe("trevor");
    expect(rec.decidedAt).toBe("2026-08-29T00:00:02.000Z");
    // Durable across restart.
    const second = new HumanReviewStore(dir);
    const persisted = await second.snapshot("S01E01_SC04_SH07");
    expect(persisted?.state).toBe("APPROVED");
    expect(persisted?.decidedBy).toBe("trevor");
  });

  it("a store opened by the pipeline can only see the decision — never fabricate one", async () => {
    // The engine-side API has no auto-approve path at all: the ONLY mutators
    // that reach APPROVED/REJECTED are approve/reject, both requiring a human.
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    const open = await store.listReviews();
    expect(open).toHaveLength(1);
    expect(open[0]?.state).toBe("REVIEW");
    expect(open[0]?.decidedBy).toBeNull();
    expect(open[0]?.decidedAt).toBeNull();
  });

  it("an APPROVED record without decidedAt/decidedBy on disk is corrupt and throws", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    // Simulate external damage: forge an approval without a human decision.
    const raw = JSON.parse(await readFile(join(dir, HUMAN_REVIEW_FILE), "utf8"));
    raw.reviews.S01E01_SC04_SH07.state = "APPROVED";
    raw.reviews.S01E01_SC04_SH07.decidedAt = null;
    raw.reviews.S01E01_SC04_SH07.decidedBy = null;
    await writeFile(join(dir, HUMAN_REVIEW_FILE), JSON.stringify(raw));
    const damaged = new HumanReviewStore(dir);
    await expect(damaged.get()).rejects.toThrow(
      /is APPROVED without decidedAt\/decidedBy — approvals require a recorded human decision/,
    );
  });

  it("a corrupt document (truncated JSON) throws — never silently auto-resets", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    await writeFile(join(dir, HUMAN_REVIEW_FILE), '{"schemaVersion":1,"revi');
    const damaged = new HumanReviewStore(dir);
    await expect(damaged.get()).rejects.toBeTruthy();
  });

  it("an unknown state in the document throws (external damage surfaces)", async () => {
    await writeFile(
      join(dir, HUMAN_REVIEW_FILE),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-08-29T00:00:00.000Z",
        reviews: {
          SH01: {
            shotId: "SH01",
            episodeId: "S01E01",
            sceneId: null,
            attempt: 0,
            trigger: "routes-exhausted",
            reason: "x",
            routesTried: [],
            state: "AUTO_APPROVED",
            enteredAt: "2026-08-29T00:00:00.000Z",
            updatedAt: "2026-08-29T00:00:00.000Z",
            decidedAt: null,
            decidedBy: null,
            note: null,
          },
        },
      }),
    );
    const damaged = new HumanReviewStore(dir);
    await expect(damaged.get()).rejects.toThrow(/corrupt state/);
  });
});

describe("HumanReviewStore — transitions and listing", () => {
  it("REVIEW → APPROVED → reopen → REJECTED follows the legal transition table", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    await store.approve("S01E01_SC04_SH07", { decidedBy: "trevor", now: tick() });
    const reopened = await store.reopen("S01E01_SC04_SH07", { note: "second look", now: tick() });
    expect(reopened.state).toBe("REVIEW");
    // Reopen clears the decision fields with the state — no stale approval.
    expect(reopened.decidedAt).toBeNull();
    expect(reopened.decidedBy).toBeNull();
    const rejected = await store.reject("S01E01_SC04_SH07", {
      decidedBy: "trevor",
      note: "identity drift confirmed",
      now: tick(),
    });
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.note).toBe("identity drift confirmed");
  });

  it("decided → decided directly is illegal; the prior decision must be reopened", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    await store.approve("S01E01_SC04_SH07", { decidedBy: "trevor", now: tick() });
    await expect(
      store.reject("S01E01_SC04_SH07", { decidedBy: "trevor", now: tick() }),
    ).rejects.toThrow(/illegal human-review transition APPROVED → REJECTED/);
  });

  it("approving an unknown shot is refused — review must be entered first", async () => {
    const store = new HumanReviewStore(dir);
    await expect(
      store.approve("NOPE", { decidedBy: "trevor" }),
    ).rejects.toThrow(/markReview first/);
  });

  it("unknown trigger, blank ids, and blank reason are refused before touching disk", async () => {
    const store = new HumanReviewStore(dir);
    await expect(
      store.markReview(markInput({ trigger: "vibes" as never })),
    ).rejects.toThrow(/unknown human-review trigger/);
    await expect(store.markReview(markInput({ shotId: " " }))).rejects.toThrow(/shotId/);
    await expect(store.markReview(markInput({ reason: "  " }))).rejects.toThrow(/reason/);
    expect(await store.openCount()).toBe(0);
  });

  it("listReviews defaults to open REVIEW items only; includeResolved adds decisions", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput({ shotId: "SH01", now: tick() }));
    await store.markReview(markInput({ shotId: "SH02", now: tick() }));
    await store.markReview(markInput({ shotId: "SH03", now: tick() }));
    await store.approve("SH02", { decidedBy: "trevor", now: tick() });
    const open = await store.listReviews();
    expect(open.map((r) => r.shotId)).toEqual(["SH01", "SH03"]);
    const all = await store.listReviews({ includeResolved: true });
    expect(all.map((r) => r.shotId)).toEqual(["SH01", "SH02", "SH03"]);
    expect(all.find((r) => r.shotId === "SH02")?.state).toBe("APPROVED");
  });

  it("listReviews filters by episode and orders oldest-entered first", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput({ shotId: "E2_SH09", episodeId: "S01E02", now: tick() }));
    await store.markReview(markInput({ shotId: "E1_SH01", episodeId: "S01E01", now: tick() }));
    await store.markReview(markInput({ shotId: "E1_SH05", episodeId: "S01E01", now: tick() }));
    const ep1 = await store.listReviews({ episodeId: "S01E01" });
    expect(ep1.map((r) => r.shotId)).toEqual(["E1_SH01", "E1_SH05"]);
  });

  it("openCount tracks open items per episode", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput({ shotId: "SH01", episodeId: "S01E01", now: tick() }));
    await store.markReview(markInput({ shotId: "SH02", episodeId: "S01E02", now: tick() }));
    await store.approve("SH02", { decidedBy: "trevor", now: tick() });
    expect(await store.openCount()).toBe(1);
    expect(await store.openCount("S01E01")).toBe(1);
    expect(await store.openCount("S01E02")).toBe(0);
  });

  it("returned records are frozen — consumers cannot mutate store state by reference", async () => {
    const store = new HumanReviewStore(dir);
    await store.markReview(markInput());
    const doc = await store.get();
    const rec = doc.reviews.S01E01_SC04_SH07;
    expect(() => {
      (rec as unknown as { state: string }).state = "APPROVED";
    }).toThrow();
  });
});

describe("normalizeHumanReviewDocument — structural validation", () => {
  it("empty document round-trips", () => {
    const doc = emptyHumanReviewDocument("2026-08-29T00:00:00.000Z");
    expect(normalizeHumanReviewDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("rejects wrong schemaVersion, non-object roots, and missing reviews map", () => {
    expect(() => normalizeHumanReviewDocument({ schemaVersion: 2, updatedAt: "2026-08-29T00:00:00.000Z", reviews: {} })).toThrow(
      /schemaVersion/,
    );
    expect(() => normalizeHumanReviewDocument(null)).toThrow(/JSON object/);
    expect(() => normalizeHumanReviewDocument({ schemaVersion: 1, updatedAt: "2026-08-29T00:00:00.000Z" })).toThrow(
      /reviews/,
    );
  });

  it("rejects a key/shotId mismatch and corrupt timestamps/triggers/attempt", async () => {
    const base = {
      schemaVersion: 1,
      updatedAt: "2026-08-29T00:00:00.000Z",
      reviews: {
        SH01: {
          shotId: "SH_OTHER",
          episodeId: "S01E01",
          sceneId: null,
          attempt: 0,
          trigger: "routes-exhausted",
          reason: "x",
          routesTried: [],
          state: "REVIEW",
          enteredAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
          decidedAt: null,
          decidedBy: null,
          note: null,
        },
      },
    };
    expect(() => normalizeHumanReviewDocument(base)).toThrow(/does not match its key/);
    const badTime = JSON.parse(JSON.stringify(base));
    badTime.reviews.SH01.shotId = "SH01";
    badTime.reviews.SH01.enteredAt = "not-a-time";
    expect(() => normalizeHumanReviewDocument(badTime)).toThrow(/ISO-8601/);
    const badTrigger = JSON.parse(JSON.stringify(badTime));
    badTrigger.reviews.SH01.enteredAt = "2026-08-29T00:00:00.000Z";
    badTrigger.reviews.SH01.trigger = "mystery";
    expect(() => normalizeHumanReviewDocument(badTrigger)).toThrow(/corrupt trigger/);
    const badAttempt = JSON.parse(JSON.stringify(badTrigger));
    badAttempt.reviews.SH01.trigger = "routes-exhausted";
    badAttempt.reviews.SH01.attempt = -1;
    expect(() => normalizeHumanReviewDocument(badAttempt)).toThrow(/attempt/);
  });
});

describe("module surface", () => {
  it("exposes exactly the three persisted states and three exhaustion triggers", () => {
    expect([...HUMAN_REVIEW_STATES]).toEqual(["REVIEW", "APPROVED", "REJECTED"]);
    expect([...HUMAN_REVIEW_TRIGGERS]).toEqual([
      "routes-exhausted",
      "qc-verdict-review",
      "review-unavailable",
    ]);
    expect(LEGAL_HUMAN_REVIEW_TRANSITIONS.REVIEW).toEqual(["APPROVED", "REJECTED"]);
    expect(LEGAL_HUMAN_REVIEW_TRANSITIONS.APPROVED).toEqual(["REVIEW"]);
    expect(LEGAL_HUMAN_REVIEW_TRANSITIONS.REJECTED).toEqual(["REVIEW"]);
  });
});
