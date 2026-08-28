/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  createVoiceProfile,
  isProductionReady,
  isValidCharacterId,
  updateVoiceProfile,
  type FishVoiceProfile,
} from "./profile.js";
import { FishVoiceProfileStore } from "./store.js";

/** Minimal in-memory fs implementing the store's seam (+ rename for atomicity). */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: string[] = [];
  return {
    files,
    ops,
    fs: {
      async readFile(p: string) {
        const v = files.get(p);
        if (v === undefined) {
          const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
          err.code = "ENOENT";
          throw err;
        }
        return v;
      },
      async writeFile(p: string, data: string) {
        ops.push(`write:${p}`);
        files.set(p, data);
      },
      async mkdir() {
        return undefined;
      },
      async rename(a: string, b: string) {
        ops.push(`rename:${a}->${b}`);
        const v = files.get(a);
        if (v !== undefined) {
          files.set(b, v);
          files.delete(a);
        }
      },
      async unlink(p: string) {
        ops.push(`unlink:${p}`);
        files.delete(p);
      },
    },
  };
}

const FIXED_NOW = new Date("2026-08-28T13:20:00.000Z");
const LATER_NOW = new Date("2026-08-28T14:00:00.000Z");

function makeStore() {
  const mem = memoryFs();
  let i = 0;
  const store = new FishVoiceProfileStore({
    filePath: "/tmp/test-voice-profiles.json",
    fs: mem.fs,
    now: () => (i++ % 2 === 0 ? FIXED_NOW : LATER_NOW),
  });
  return { mem, store };
}

function makeProfile(overrides: Partial<FishVoiceProfile> = {}): FishVoiceProfile {
  return {
    ...createVoiceProfile("CHAR_TEST_001", { fishVoiceId: "voice-1", model: "s2-pro" }),
    ...overrides,
  };
}

describe("createVoiceProfile — spec §30 fields", () => {
  it("creates a full profile bound to a stable character ID", () => {
    const p = createVoiceProfile("CHAR_MONICA_BENNETT_001", {
      fishVoiceId: "fish-voice-abc",
      model: "s2-pro",
      pace: "slow",
      emotionStyle: "warm, wry, low energy",
      pronunciationDictionary: [{ term: "Bennett", pronunciation: "BEN-it" }],
      importantProperNouns: ["Bennett", "Kestrel Falls"],
    });
    expect(p.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(p.fishVoiceId).toBe("fish-voice-abc");
    expect(p.model).toBe("s2-pro");
    expect(p.pace).toBe("slow");
    expect(p.emotionStyle).toBe("warm, wry, low energy");
    expect(p.pronunciationDictionary).toEqual([{ term: "Bennett", pronunciation: "BEN-it" }]);
    expect(p.importantProperNouns).toEqual(["Bennett", "Kestrel Falls"]);
    expect(p.testSampleStatus).toBe("none");
    expect(p.approvalStatus).toBe("DRAFT");
    expect(p.version).toBe(1);
    expect(p.createdAt).toBeTruthy();
    expect(p.updatedAt).toBeTruthy();
  });

  it("rejects a display-name-style character ID (never name-keyed)", () => {
    expect(() => createVoiceProfile("Monica Bennett", { fishVoiceId: "v", model: "m" })).toThrow(
      /characterId/,
    );
  });

  it("requires fishVoiceId and model", () => {
    expect(() => createVoiceProfile("CHAR_A_001", {})).toThrow(/fishVoiceId is required/);
    expect(() => createVoiceProfile("CHAR_A_001", { fishVoiceId: "v" })).toThrow(/model is required/);
  });

  it("rejects unknown enum values", () => {
    expect(() =>
      createVoiceProfile("CHAR_A_001", { fishVoiceId: "v", model: "m", pace: "warp" as never }),
    ).toThrow(/pace/);
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        testSampleStatus: "maybe" as never,
      }),
    ).toThrow(/testSampleStatus/);
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        approvalStatus: "MAYBE" as never,
      }),
    ).toThrow(/approvalStatus/);
  });

  it("rejects blank dictionary entries and trims valid ones", () => {
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        pronunciationDictionary: [{ term: "  ", pronunciation: "x" }],
      }),
    ).toThrow(/term is required/);
    const p = createVoiceProfile("CHAR_A_001", {
      fishVoiceId: "v",
      model: "m",
      pronunciationDictionary: [{ term: " Kestrel ", pronunciation: " KES-trul " }],
      importantProperNouns: ["  Bennett  "],
    });
    expect(p.pronunciationDictionary).toEqual([{ term: "Kestrel", pronunciation: "KES-trul" }]);
    expect(p.importantProperNouns).toEqual(["Bennett"]);
  });

  it("rejects blank proper-noun entries (regression: blank nouns silently masked)", () => {
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        importantProperNouns: ["Bennett", "   "],
      }),
    ).toThrow(/importantProperNouns/);
  });
});

describe("updateVoiceProfile — immutability + versioning", () => {
  it("updates voice-defining fields and bumps version", () => {
    const base = makeProfile({ createdAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z" });
    const next = updateVoiceProfile(base, { pace: "fast", emotionStyle: "urgent" });
    expect(next.pace).toBe("fast");
    expect(next.emotionStyle).toBe("urgent");
    expect(next.version).toBe(2);
    expect(next.updatedAt).not.toBe(base.updatedAt);
  });

  it("does not bump version when nothing changed", () => {
    const base = makeProfile();
    const next = updateVoiceProfile(base, { emotionStyle: base.emotionStyle });
    expect(next.version).toBe(base.version);
  });

  it("rejects changing characterId — the binding is permanent", () => {
    const base = makeProfile();
    expect(() =>
      updateVoiceProfile(base, { characterId: "CHAR_OTHER_001" } as never),
    ).toThrow(/immutable/);
  });

  it("tracks test-sample status transitions and asset binding", () => {
    const base = makeProfile({ createdAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z" });
    const generated = updateVoiceProfile(base, {
      testSampleStatus: "generated",
      testSampleAssetId: "asset_test_1",
    });
    expect(generated.testSampleStatus).toBe("generated");
    expect(generated.testSampleAssetId).toBe("asset_test_1");
    const approved = updateVoiceProfile(generated, { testSampleStatus: "approved" });
    expect(approved.testSampleStatus).toBe("approved");
    expect(approved.testSampleAssetId).toBe("asset_test_1");
  });

  it("recording an asset while status is 'none' implies 'generated'", () => {
    const base = makeProfile();
    const next = updateVoiceProfile(base, { testSampleAssetId: "asset_x" });
    expect(next.testSampleStatus).toBe("generated");
  });

  it("rejects blank proper-noun entries on update too (regression)", () => {
    const base = makeProfile();
    expect(() =>
      updateVoiceProfile(base, { importantProperNouns: ["Ok", "  "] }),
    ).toThrow(/importantProperNouns/);
  });
});

describe("isProductionReady", () => {
  it("requires approval AND an approved test sample", () => {
    expect(isProductionReady(makeProfile({ approvalStatus: "APPROVED", testSampleStatus: "none" }))).toBe(false);
    expect(isProductionReady(makeProfile({ approvalStatus: "DRAFT", testSampleStatus: "approved" }))).toBe(false);
    expect(isProductionReady(makeProfile({ approvalStatus: "APPROVED", testSampleStatus: "approved" }))).toBe(true);
    expect(isProductionReady(makeProfile({ approvalStatus: "CANONICAL", testSampleStatus: "approved" }))).toBe(true);
    expect(isProductionReady(makeProfile({ approvalStatus: "RETIRED", testSampleStatus: "approved" }))).toBe(false);
  });
});

describe("isValidCharacterId", () => {
  it("accepts stable MMCS IDs and rejects display names", () => {
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_001")).toBe(true);
    expect(isValidCharacterId("CHAR_A_1")).toBe(true);
    expect(isValidCharacterId("monica")).toBe(false);
    expect(isValidCharacterId("Monica Bennett")).toBe(false);
    expect(isValidCharacterId("")).toBe(false);
  });
});

describe("FishVoiceProfileStore — create/persist/list", () => {
  it("persists a profile and lists it back", async () => {
    const { mem, store } = makeStore();
    const created = await store.create("CHAR_MONICA_BENNETT_001", {
      fishVoiceId: "fish-voice-abc",
      model: "s2-pro",
      pace: "normal",
      emotionStyle: "warm",
      pronunciationDictionary: [{ term: "Bennett", pronunciation: "BEN-it" }],
      importantProperNouns: ["Bennett"],
      testSampleStatus: "pending",
      approvalStatus: "REVIEW",
    });

    expect(created.characterId).toBe("CHAR_MONICA_BENNETT_001");
    // Persisted to disk.
    const onDisk = JSON.parse(mem.files.get("/tmp/test-voice-profiles.json")!);
    expect(onDisk.formatVersion).toBe(1);
    expect(onDisk.profiles.CHAR_MONICA_BENNETT_001.fishVoiceId).toBe("fish-voice-abc");

    // A NEW store instance over the same file sees it (durable persistence).
    const second = new FishVoiceProfileStore({
      filePath: "/tmp/test-voice-profiles.json",
      fs: mem.fs,
      now: () => FIXED_NOW,
    });
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.characterId).toBe("CHAR_MONICA_BENNETT_001");
    const got = await second.get("CHAR_MONICA_BENNETT_001");
    expect(got?.pace).toBe("normal");
    expect(got?.pronunciationDictionary[0]?.term).toBe("Bennett");
  });

  it("enforces one profile per character (binding is permanent)", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "v1", model: "s2-pro" });
    await expect(store.create("CHAR_A_001", { fishVoiceId: "v2", model: "s2-pro" })).rejects.toThrow(
      /already exists for character CHAR_A_001/,
    );
  });

  it("rejects invalid character IDs at the store boundary too", async () => {
    const { store } = makeStore();
    await expect(store.create("monica", { fishVoiceId: "v", model: "m" })).rejects.toThrow(/characterId/);
  });

  it("updates the persisted profile and preserves the binding", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "v1", model: "s2-pro" });
    const updated = await store.update("CHAR_A_001", { fishVoiceId: "v2", pace: "fast" });
    expect(updated.fishVoiceId).toBe("v2");
    expect(updated.pace).toBe("fast");
    expect(updated.version).toBe(2);
    expect(updated.characterId).toBe("CHAR_A_001");

    const reread = await store.get("CHAR_A_001");
    expect(reread?.fishVoiceId).toBe("v2");
    expect(reread?.version).toBe(2);
  });

  it("update throws when no profile exists for the character", async () => {
    const { store } = makeStore();
    await expect(store.update("CHAR_MISSING_001", { pace: "fast" })).rejects.toThrow(
      /No voice profile exists for character CHAR_MISSING_001/,
    );
  });

  it("listForCharacters returns only matching, in requested order", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "va", model: "m" });
    await store.create("CHAR_B_001", { fishVoiceId: "vb", model: "m" });
    const out = await store.listForCharacters(["CHAR_B_001", "CHAR_C_001", "CHAR_A_001"]);
    expect(out.map((p) => p.characterId)).toEqual(["CHAR_B_001", "CHAR_A_001"]);
  });

  it("listForCharacters dedupes repeated IDs (regression: duplicate rows)", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "va", model: "m" });
    const out = await store.listForCharacters(["CHAR_A_001", "CHAR_A_001"]);
    expect(out.map((p) => p.characterId)).toEqual(["CHAR_A_001"]);
  });

  it("recordTestSample persists status + asset id", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" });
    const afterGen = await store.recordTestSample("CHAR_A_001", {
      status: "generated",
      assetId: "asset_ts_1",
    });
    expect(afterGen.testSampleStatus).toBe("generated");
    expect(afterGen.testSampleAssetId).toBe("asset_ts_1");
    const afterApprove = await store.recordTestSample("CHAR_A_001", { status: "approved" });
    expect(afterApprove.testSampleStatus).toBe("approved");
    expect(afterApprove.testSampleAssetId).toBe("asset_ts_1");
  });

  it("isProductionReady gates on persisted approval + sample state", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" });
    expect(await store.isProductionReady("CHAR_A_001")).toBe(false);
    await store.update("CHAR_A_001", { approvalStatus: "APPROVED" });
    expect(await store.isProductionReady("CHAR_A_001")).toBe(false);
    await store.recordTestSample("CHAR_A_001", { status: "approved" });
    expect(await store.isProductionReady("CHAR_A_001")).toBe(true);
    expect(await store.isProductionReady("CHAR_MISSING_001")).toBe(false);
  });

  it("missing store file is an empty store, not an error", async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get("CHAR_A_001")).toBeUndefined();
  });

  it("malformed store file raises a clear error", async () => {
    const mem = memoryFs({ "/tmp/bad.json": "not json at all" });
    const store = new FishVoiceProfileStore({ filePath: "/tmp/bad.json", fs: mem.fs });
    await expect(store.list()).rejects.toThrow(/Voice profile store at \/tmp\/bad\.json is malformed|not json|JSON/i);
  });

  it("rejects a store document whose profiles is an array (regression: typeof array === 'object')", async () => {
    const mem = memoryFs({ "/tmp/arr.json": '{"formatVersion":1,"profiles":[]}' });
    const store = new FishVoiceProfileStore({ filePath: "/tmp/arr.json", fs: mem.fs });
    await expect(store.list()).rejects.toThrow(/malformed/);
  });

  it("serializes concurrent creates and updates (read-modify-write safe)", async () => {
    const { store } = makeStore();
    await store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" });
    await Promise.all([
      store.update("CHAR_A_001", { pace: "slow" }),
      store.update("CHAR_A_001", { pace: "fast" }),
      store.recordTestSample("CHAR_A_001", { status: "generated", assetId: "a1" }),
      store.update("CHAR_A_001", { emotionStyle: "calm" }),
    ]);
    const final = await store.get("CHAR_A_001");
    // Every write applied exactly once, no lost update; version advanced once per change.
    expect(final?.version).toBe(5);
  });

  it("update restamps updatedAt with the injected clock (regression: real clock leaked)", async () => {
    const mem = memoryFs();
    const fixed = new Date("2026-08-28T12:00:00.000Z");
    const store = new FishVoiceProfileStore({
      filePath: "/tmp/test-voice-profiles.json",
      fs: mem.fs,
      now: () => fixed,
    });
    await store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" });
    const updated = await store.update("CHAR_A_001", { pace: "slow" });
    expect(updated.updatedAt).toBe("2026-08-28T12:00:00.000Z");
    const noop = await store.update("CHAR_A_001", { pace: "slow" });
    expect(noop.version).toBe(updated.version);
    expect(noop.updatedAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("cleans up the temp file when rename fails (regression: .tmp orphans)", async () => {
    const mem = memoryFs();
    let failRename = true;
    const failingFs = {
      ...mem.fs,
      async rename(a: string, b: string) {
        if (failRename) throw new Error("rename boom");
        await mem.fs.rename(a, b);
      },
    };
    const store = new FishVoiceProfileStore({
      filePath: "/tmp/test-voice-profiles.json",
      fs: failingFs,
    });
    await expect(
      store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" }),
    ).rejects.toThrow(/rename boom/);
    failRename = false;
    await store.create("CHAR_A_001", { fishVoiceId: "v", model: "m" });
    const tmpLeft = [...mem.files.keys()].filter((k) => k.includes(".tmp-"));
    expect(tmpLeft).toEqual([]);
  });
});