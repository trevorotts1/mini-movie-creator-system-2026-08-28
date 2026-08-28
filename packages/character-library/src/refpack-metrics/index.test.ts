/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLIP_OUTCOMES,
  isClipOutcome,
  RefpackMetricsStore,
  type RecordedOutcomeInput,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const AGNES = "agnes-flash-25";

async function tmpStore(): Promise<{ store: RefpackMetricsStore; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "refpack-metrics-"));
  const filePath = path.join(dir, "refpack-metrics.json");
  return { store: new RefpackMetricsStore({ filePath }), filePath };
}

function outcome(overrides: Partial<RecordedOutcomeInput> = {}): RecordedOutcomeInput {
  return {
    characterId: MONICA,
    model: AGNES,
    referenceIds: ["ASSET_MONICA_FACE_FRONT_MASTER_V1"],
    outcome: "ACCEPTED",
    ...overrides,
  };
}

describe("record", () => {
  it("persists which references produced an accepted clip", async () => {
    const { store, filePath } = await tmpStore();
    const recorded = await store.record(
      outcome({
        referenceIds: ["ASSET_MONICA_FACE_3Q_MASTER_V1", "ASSET_MONICA_FULL_BODY_V1"],
        shotId: "SH07",
        jobId: "job-123",
      }),
    );
    expect(recorded.id).toBe(1);
    expect(recorded.outcome).toBe("ACCEPTED");
    expect(recorded.referenceIds).toEqual([
      "ASSET_MONICA_FACE_3Q_MASTER_V1",
      "ASSET_MONICA_FULL_BODY_V1",
    ]);
    expect(recorded.shotId).toBe("SH07");
    expect(recorded.jobId).toBe("job-123");
    // durable: a fresh store over the same file sees the record
    const reopened = new RefpackMetricsStore({ filePath });
    const listed = await reopened.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.referenceIds).toEqual(recorded.referenceIds);
  });

  it("persists rejected clips with their reason", async () => {
    const { store } = await tmpStore();
    const recorded = await store.record(
      outcome({ outcome: "REJECTED", reason: "face inconsistent with canonical master" }),
    );
    expect(recorded.outcome).toBe("REJECTED");
    expect(recorded.reason).toBe("face inconsistent with canonical master");
    const listed = await store.list();
    expect(listed[0]?.outcome).toBe("REJECTED");
  });

  it("copies referenceIds (input mutation does not affect the record)", async () => {
    const { store } = await tmpStore();
    const refs = ["ASSET_A"];
    await store.record(outcome({ referenceIds: refs }));
    refs.push("ASSET_B");
    const listed = await store.list();
    expect(listed[0]?.referenceIds).toEqual(["ASSET_A"]);
  });

  it("normalizes unknown optionals to explicit nulls", async () => {
    const { store } = await tmpStore();
    const recorded = await store.record(outcome());
    expect(recorded.shotId).toBeNull();
    expect(recorded.jobId).toBeNull();
    expect(recorded.reason).toBeNull();
  });

  it("rejects invalid outcome values and empty required fields", async () => {
    const { store } = await tmpStore();
    await expect(store.record(outcome({ outcome: "MAYBE" as never }))).rejects.toThrow(
      /ACCEPTED \| REJECTED/,
    );
    await expect(store.record(outcome({ characterId: "" }))).rejects.toThrow(/characterId/);
    await expect(store.record(outcome({ model: "" }))).rejects.toThrow(/model/);
    await expect(
      store.record(outcome({ referenceIds: ["", "ASSET_A"] })),
    ).rejects.toThrow(/non-empty strings/);
  });

  it("dedupes on dedupeKey (job replay does not double-count)", async () => {
    const { store } = await tmpStore();
    const first = await store.record(outcome({ dedupeKey: "job-123" }));
    const again = await store.record(
      outcome({ outcome: "REJECTED", dedupeKey: "job-123" }),
    );
    expect(again.id).toBe(first.id);
    expect(again.outcome).toBe("ACCEPTED");
    expect(await store.list()).toHaveLength(1);
  });

  it("records many outcomes in one write with per-entry dedupe", async () => {
    const { store } = await tmpStore();
    const recorded = await store.recordMany([
      outcome({ referenceIds: ["ASSET_A"], dedupeKey: "job-1" }),
      outcome({ outcome: "REJECTED", referenceIds: ["ASSET_A", "ASSET_B"], dedupeKey: "job-2" }),
      outcome({ referenceIds: ["ASSET_B"], dedupeKey: "job-1" }), // dup -> first wins
    ]);
    expect(recorded).toHaveLength(3);
    expect(recorded[2]).toEqual(recorded[0]);
    expect(await store.list()).toHaveLength(2);
  });
});

describe("successRateByReference (character/model/reference combination query)", () => {
  it("computes historical success rate per reference for a character+model", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      // ASSET_FACE: 3 samples, 2 accepted -> 2/3
      outcome({ referenceIds: ["ASSET_FACE"], outcome: "ACCEPTED" }),
      outcome({ referenceIds: ["ASSET_FACE"], outcome: "ACCEPTED" }),
      outcome({ referenceIds: ["ASSET_FACE"], outcome: "REJECTED" }),
      // ASSET_BRAIDS: 1 sample, rejected -> 0/1
      outcome({ referenceIds: ["ASSET_BRAIDS"], outcome: "REJECTED" }),
      // a pack using both: counts once per reference
      outcome({ referenceIds: ["ASSET_FACE", "ASSET_BRAIDS"], outcome: "ACCEPTED" }),
    ]);
    const rates = await store.successRateByReference(MONICA, AGNES);
    const face = rates.find((r) => r.referenceId === "ASSET_FACE");
    const braids = rates.find((r) => r.referenceId === "ASSET_BRAIDS");
    expect(face).toMatchObject({ samples: 4, accepted: 3, rejected: 1, rate: 3 / 4 });
    expect(braids).toMatchObject({ samples: 2, accepted: 1, rejected: 1, rate: 0.5 });
  });

  it("never mixes models: same reference under another model stays separate", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ model: AGNES, referenceIds: ["ASSET_FACE"], outcome: "ACCEPTED" }),
      outcome({
        model: "seedance-pro",
        referenceIds: ["ASSET_FACE"],
        outcome: "REJECTED",
      }),
    ]);
    const agnes = await store.successRateForReference(MONICA, AGNES, "ASSET_FACE");
    const seedance = await store.successRateForReference(MONICA, "seedance-pro", "ASSET_FACE");
    expect(agnes).toMatchObject({ samples: 1, accepted: 1, rate: 1 });
    expect(seedance).toMatchObject({ samples: 1, accepted: 0, rate: 0 });
  });

  it("returns rate null (not 0) with no samples — no history is not failure", async () => {
    const { store } = await tmpStore();
    await store.record(outcome({ referenceIds: ["ASSET_FACE"] }));
    const unknown = await store.successRateForReference(MONICA, AGNES, "ASSET_NEVER_USED");
    expect(unknown).toEqual({ samples: 0, accepted: 0, rejected: 0, rate: null });
    const none = await store.successRateByReference(MONICA, "seedance-pro");
    expect(none).toEqual([]);
  });

  it("respects a decision-time cutoff so the planner never sees the future", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ occurredAt: "2026-08-01T00:00:00.000Z", outcome: "REJECTED" }),
      outcome({ occurredAt: "2026-08-10T00:00:00.000Z", outcome: "ACCEPTED" }),
    ]);
    const atFirst = await store.successRateForReference(
      MONICA,
      AGNES,
      "ASSET_MONICA_FACE_FRONT_MASTER_V1",
      "2026-08-05T00:00:00.000Z",
    );
    expect(atFirst).toMatchObject({ samples: 1, accepted: 0, rate: 0 });
    const now = await store.successRateForReference(
      MONICA,
      AGNES,
      "ASSET_MONICA_FACE_FRONT_MASTER_V1",
    );
    expect(now).toMatchObject({ samples: 2, accepted: 1, rate: 0.5 });
  });
});

describe("successRateForPack", () => {
  it("scores an exact reference pack (order-insensitive)", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ referenceIds: ["ASSET_FACE", "ASSET_BODY"], outcome: "ACCEPTED" }),
      outcome({ referenceIds: ["ASSET_BODY", "ASSET_FACE"], outcome: "REJECTED" }),
      outcome({ referenceIds: ["ASSET_FACE"], outcome: "ACCEPTED" }),
    ]);
    const pack = await store.successRateForPack(MONICA, AGNES, [
      "ASSET_BODY",
      "ASSET_FACE",
    ]);
    expect(pack).toMatchObject({ samples: 2, accepted: 1, rejected: 1, rate: 0.5 });
    expect(pack.referenceIds.sort()).toEqual(["ASSET_BODY", "ASSET_FACE"].sort());
  });

  it("returns rate null for a never-seen pack", async () => {
    const { store } = await tmpStore();
    const pack = await store.successRateForPack(MONICA, AGNES, ["ASSET_X", "ASSET_Y"]);
    expect(pack).toEqual({
      referenceIds: ["ASSET_X", "ASSET_Y"],
      samples: 0,
      accepted: 0,
      rejected: 0,
      rate: null,
    });
  });

  it("lists all seen packs best-known first with accepted/rejected split", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ referenceIds: ["ASSET_FACE", "ASSET_BODY"], outcome: "ACCEPTED" }),
      outcome({ referenceIds: ["ASSET_FACE", "ASSET_BODY"], outcome: "ACCEPTED" }),
      outcome({ referenceIds: ["ASSET_FACE"], outcome: "REJECTED" }),
    ]);
    const packs = await store.successRateByPack(MONICA, AGNES);
    expect(packs).toHaveLength(2);
    expect(packs[0]?.samples).toBe(2);
    expect(packs[0]?.rate).toBe(1);
    expect(packs[1]).toMatchObject({ samples: 1, accepted: 0, rejected: 1 });
  });
});

describe("outcome vocabulary", () => {
  it("exposes exactly the spec terminal outcomes", () => {
    expect(CLIP_OUTCOMES).toEqual(["ACCEPTED", "REJECTED"]);
    expect(isClipOutcome("ACCEPTED")).toBe(true);
    expect(isClipOutcome("REJECTED")).toBe(true);
    expect(isClipOutcome("accepted")).toBe(false);
    expect(isClipOutcome(42)).toBe(false);
  });
});

describe("timestamp normalization", () => {
  it("stores mixed-offset caller timestamps as comparable UTC instants", async () => {
    const { store } = await tmpStore();
    // same instant, different offsets — must normalize to the same string
    await store.recordMany([
      outcome({ occurredAt: "2026-08-05T00:00:00.000-05:00" }),
      outcome({ occurredAt: "2026-08-05T05:00:00.000Z" }),
    ]);
    const listed = await store.list();
    expect(listed[0]?.occurredAt).toBe("2026-08-05T05:00:00.000Z");
    expect(listed[1]?.occurredAt).toBe("2026-08-05T05:00:00.000Z");
  });

  it("rejects caller timestamps that are not valid ISO 8601 instants", async () => {
    const { store } = await tmpStore();
    await expect(
      store.record(outcome({ occurredAt: "tomorrow-ish" })),
    ).rejects.toThrow(/valid ISO 8601 instant/);
    await expect(store.record(outcome({ occurredAt: "" }))).rejects.toThrow(/occurredAt/);
  });
});

describe("malformed store file", () => {
  async function writeDoc(filePath: string, doc: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(doc), "utf8");
  }

  it("fails loudly on a corrupt outcome row instead of skewing rates", async () => {
    const { filePath } = await tmpStore();
    await writeDoc(filePath, {
      formatVersion: 1,
      outcomes: {
        "1": {
          id: 1,
          characterId: MONICA,
          model: AGNES,
          referenceIds: ["ASSET_FACE"],
          outcome: "KINDA-OK", // not in the vocabulary
          shotId: null,
          jobId: null,
          reason: null,
          occurredAt: "2026-08-01T00:00:00.000Z",
        },
      },
      dedupeIndex: {},
      nextId: 2,
    });
    const store = new RefpackMetricsStore({ filePath });
    await expect(store.list()).rejects.toThrow(/malformed/);
  });

  it("fails loudly on a top-level shape mismatch", async () => {
    const { filePath } = await tmpStore();
    await writeDoc(filePath, { formatVersion: 2, outcomes: {}, dedupeIndex: {}, nextId: 1 });
    const store = new RefpackMetricsStore({ filePath });
    await expect(store.list()).rejects.toThrow(/malformed/);
  });
});

describe("read accessors", () => {
  it("get returns one outcome by id", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ referenceIds: ["ASSET_A"] }),
      outcome({ referenceIds: ["ASSET_B"], outcome: "REJECTED" }),
    ]);
    expect((await store.get(2))?.referenceIds).toEqual(["ASSET_B"]);
    expect(await store.get(99)).toBeUndefined();
  });

  it("listForCharacter filters by character (any model/reference)", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ characterId: MONICA, referenceIds: ["ASSET_A"] }),
      outcome({ characterId: "CHAR_OTHER_002", referenceIds: ["ASSET_B"] }),
    ]);
    const monica = await store.listForCharacter(MONICA);
    expect(monica).toHaveLength(1);
    expect(monica[0]?.referenceIds).toEqual(["ASSET_A"]);
  });

  it("listForShot returns outcomes for one shot (repair-loop queries)", async () => {
    const { store } = await tmpStore();
    await store.recordMany([
      outcome({ shotId: "SH01", referenceIds: ["ASSET_A"], outcome: "REJECTED" }),
      outcome({ shotId: "SH01", referenceIds: ["ASSET_B"] }),
      outcome({ shotId: "SH02", referenceIds: ["ASSET_A"] }),
    ]);
    const shot = await store.listForShot("SH01");
    expect(shot).toHaveLength(2);
    expect(shot.every((o) => o.shotId === "SH01")).toBe(true);
  });
});