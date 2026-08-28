/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  createVoiceProfile,
  isProductionReady,
  isValidCharacterId,
  updateVoiceProfile,
  type VoiceProfile,
} from "./profile.js";
import { VoiceProfileStore } from "./store.js";
import {
  bindingFingerprint,
  resolveCastBindings,
  resolveSynthesisBinding,
  stableStringify,
  verifyVoiceStability,
  type SynthesisBinding,
} from "./determinism.js";

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
    },
  };
}

const FIXED_NOW = new Date("2026-08-28T13:20:00.000Z");
const LATER_NOW = new Date("2026-08-28T14:00:00.000Z");

function makeStore() {
  const mem = memoryFs();
  let i = 0;
  const store = new VoiceProfileStore({
    filePath: "/tmp/test-voice-binding-profiles.json",
    fs: mem.fs,
    now: () => (i++ % 2 === 0 ? FIXED_NOW : LATER_NOW),
  });
  return { mem, store };
}

function sampleInput() {
  return {
    fishVoiceId: "54a1e4b0-4a5f-4a1e-9c2f-fishvoice01",
    model: "s2-pro",
    pace: "normal" as const,
    emotionStyle: "warm, wry, low-energy; slight smile in the voice",
    pronunciationDictionary: [
      { term: "Nguyen", pronunciation: "n-WIN" },
      { term: "Qilin", pronunciation: "chee-lin" },
    ],
    importantProperNouns: ["Monica Bennett", "Qilin Analytics", "S01E09"],
    testSampleStatus: "none" as const,
    approvalStatus: "DRAFT" as const,
  };
}

async function seededProfiles() {
  const { store } = makeStore();
  const monica = await store.create("CHAR_MONICA_BENNETT_001", sampleInput());
  const marcus = await store.create("CHAR_MARCUS_HALE_001", {
    fishVoiceId: "7b2f9e10-marcus-voice-02",
    model: "s2-pro",
    pace: "slow",
    emotionStyle: "measured, grave",
    importantProperNouns: ["Marcus Hale"],
  });
  return { store, monica, marcus };
}

async function profilesMap(store: VoiceProfileStore) {
  const list = await store.list();
  const map: Record<string, VoiceProfile> = {};
  for (const p of list) map[p.characterId] = p;
  return map;
}

describe("createVoiceProfile", () => {
  it("creates a full spec §30 record with all required fields", () => {
    const p = createVoiceProfile("CHAR_MONICA_BENNETT_001", sampleInput());
    expect(p.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(p.fishVoiceId).toBe("54a1e4b0-4a5f-4a1e-9c2f-fishvoice01");
    expect(p.model).toBe("s2-pro");
    expect(p.pace).toBe("normal");
    expect(p.emotionStyle).toContain("warm");
    expect(p.pronunciationDictionary).toEqual([
      { term: "Nguyen", pronunciation: "n-WIN" },
      { term: "Qilin", pronunciation: "chee-lin" },
    ]);
    expect(p.importantProperNouns).toEqual([
      "Monica Bennett",
      "Qilin Analytics",
      "S01E09",
    ]);
    expect(p.testSampleStatus).toBe("none");
    expect(p.approvalStatus).toBe("DRAFT");
    expect(p.version).toBe(1);
    expect(p.createdAt).toBeTruthy();
    expect(p.updatedAt).toBeTruthy();
  });

  it("defaults pace/testSample/approval when omitted", () => {
    const p = createVoiceProfile("CHAR_TEST_001", {
      fishVoiceId: "v1",
      model: "s1",
    });
    expect(p.pace).toBe("normal");
    expect(p.testSampleStatus).toBe("none");
    expect(p.approvalStatus).toBe("DRAFT");
    expect(p.emotionStyle).toBe("");
    expect(p.pronunciationDictionary).toEqual([]);
    expect(p.importantProperNouns).toEqual([]);
  });

  it("rejects display-name-keyed or lowercase character IDs", () => {
    expect(isValidCharacterId("Monica")).toBe(false);
    expect(isValidCharacterId("monica_bennett")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_001")).toBe(true);
    expect(() =>
      createVoiceProfile("Monica", { fishVoiceId: "v", model: "m" }),
    ).toThrow(/stable MMCS ID/);
  });

  it("requires fishVoiceId and model", () => {
    expect(() => createVoiceProfile("CHAR_A_001", { model: "m" })).toThrow(
      /fishVoiceId is required/,
    );
    expect(() =>
      createVoiceProfile("CHAR_A_001", { fishVoiceId: "v" }),
    ).toThrow(/model is required/);
  });

  it("rejects blank pronunciation entries", () => {
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        pronunciationDictionary: [{ term: "  ", pronunciation: "x" }],
      }),
    ).toThrow(/pronunciation\[0\]\.term is required/);
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        pronunciationDictionary: [{ term: "x", pronunciation: "" }],
      }),
    ).toThrow(/pronunciation\[0\]\.pronunciation is required/);
  });

  it("rejects unknown enum values", () => {
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        pace: "ludicrous" as never,
      }),
    ).toThrow(/pace must be one of/);
    expect(() =>
      createVoiceProfile("CHAR_A_001", {
        fishVoiceId: "v",
        model: "m",
        approvalStatus: "SURE" as never,
      }),
    ).toThrow(/approvalStatus must be one of/);
  });
});

describe("updateVoiceProfile", () => {
  it("bumps version only when a voice-defining field changed", () => {
    const base = createVoiceProfile("CHAR_A_001", sampleInput());
    const noop = updateVoiceProfile(base, {});
    expect(noop.version).toBe(1);
    const pace = updateVoiceProfile(base, { pace: "fast" });
    expect(pace.version).toBe(2);
    expect(pace.pace).toBe("fast");
  });

  it("rejects an immutable characterId change", () => {
    const base = createVoiceProfile("CHAR_A_001", sampleInput());
    expect(() =>
      updateVoiceProfile(base, {
        characterId: "CHAR_B_001",
      } as never),
    ).toThrow(/characterId is immutable/);
  });

  it("updates dictionary and proper nouns with normalization", () => {
    const base = createVoiceProfile("CHAR_A_001", sampleInput());
    const next = updateVoiceProfile(base, {
      pronunciationDictionary: [{ term: " Kael ", pronunciation: "kayl" }],
      importantProperNouns: [" Kael Rho "],
    });
    expect(next.pronunciationDictionary).toEqual([
      { term: "Kael", pronunciation: "kayl" },
    ]);
    expect(next.importantProperNouns).toEqual(["Kael Rho"]);
    expect(next.version).toBe(2);
  });

  it("recording a test-sample asset flips status none->generated", () => {
    const base = createVoiceProfile("CHAR_A_001", sampleInput());
    const next = updateVoiceProfile(base, { testSampleAssetId: "ASSET_9" });
    expect(next.testSampleStatus).toBe("generated");
    expect(next.testSampleAssetId).toBe("ASSET_9");
  });

  it("isProductionReady requires approval + approved sample", () => {
    const base = createVoiceProfile("CHAR_A_001", sampleInput());
    expect(isProductionReady(base)).toBe(false);
    const approved = updateVoiceProfile(base, {
      approvalStatus: "APPROVED",
      testSampleStatus: "approved",
    });
    expect(isProductionReady(approved)).toBe(true);
  });
});

describe("VoiceProfileStore", () => {
  it("persists, reloads, and enforces one profile per character", async () => {
    const { mem, store } = makeStore();
    const created = await store.create("CHAR_MONICA_BENNETT_001", sampleInput());
    await expect(
      store.create("CHAR_MONICA_BENNETT_001", sampleInput()),
    ).rejects.toThrow(/one voice per character/);

    const reloaded = new VoiceProfileStore({
      filePath: "/tmp/test-voice-binding-profiles.json",
      fs: mem.fs,
    });
    const fetched = await reloaded.get("CHAR_MONICA_BENNETT_001");
    expect(fetched).toEqual(created);

    const updated = await store.update("CHAR_MONICA_BENNETT_001", {
      pace: "slow",
    });
    expect(updated.pace).toBe("slow");
    expect(updated.version).toBe(2);
    expect((await reloaded.get("CHAR_MONICA_BENNETT_001"))?.version).toBe(2);
    expect(mem.ops.some((o) => o.startsWith("rename:"))).toBe(true);
  });

  it("update on a missing character throws; recordTestSample persists", async () => {
    const { store } = makeStore();
    await expect(
      store.update("CHAR_NOPE_001", { pace: "fast" }),
    ).rejects.toThrow(/No voice profile exists/);
    await store.create("CHAR_A_001", sampleInput());
    const after = await store.recordTestSample("CHAR_A_001", {
      status: "approved",
      assetId: "ASSET_1",
    });
    expect(after.testSampleStatus).toBe("approved");
    expect(await store.isProductionReady("CHAR_A_001")).toBe(false);
    const ready = await store.update("CHAR_A_001", {
      approvalStatus: "APPROVED",
    });
    expect(ready.approvalStatus).toBe("APPROVED");
    expect(await store.isProductionReady("CHAR_A_001")).toBe(true);
  });

  it("listForCharacters returns only bound, deduped profiles", async () => {
    const { store } = makeStore();
    await store.create("CHAR_MONICA_BENNETT_001", sampleInput());
    await store.create("CHAR_MARCUS_HALE_001", {
      fishVoiceId: "marcus-voice-7",
      model: "s2-pro",
    });
    const bound = await store.listForCharacters([
      "CHAR_MARCUS_HALE_001",
      "CHAR_GHOST_999",
      "CHAR_MARCUS_HALE_001",
    ]);
    expect(bound.map((p) => p.characterId)).toEqual(["CHAR_MARCUS_HALE_001"]);
    expect(await store.list()).toHaveLength(2);
  });

  it("serializes concurrent creates without losing writes", async () => {
    const { store } = makeStore();
    const ids = Array.from({ length: 12 }, (_, i) => `CHAR_CAST_${String(i).padStart(3, "0")}`);
    await Promise.all(
      ids.map((id, i) =>
        store.create(id, {
          fishVoiceId: `voice-${i}`,
          model: "s2-pro",
        }),
      ),
    );
    const all = await store.list();
    expect(all).toHaveLength(12);
    expect(new Set(all.map((p) => p.characterId)).size).toBe(12);
  });

  it("malformed store file throws (not silently empty)", async () => {
    const mem = memoryFs({
      "/tmp/broken.json": JSON.stringify({ formatVersion: 2, profiles: {} }),
    });
    const broken = new VoiceProfileStore({
      filePath: "/tmp/broken.json",
      fs: mem.fs,
    });
    await expect(broken.get("CHAR_A_001")).rejects.toThrow(/malformed/);
  });
});

describe("voice determinism across episodes", () => {
  it("same store -> identical binding for the same character across 'episodes'", async () => {
    const { store } = makeStore();
    await store.create("CHAR_MONICA_BENNETT_001", sampleInput());

    // Simulate two independent episode pipelines resolving the voice binding.
    const episode2 = resolveSynthesisBinding(
      await profilesMap(store),
      "CHAR_MONICA_BENNETT_001",
    );
    const episode3 = resolveSynthesisBinding(
      await profilesMap(store),
      "CHAR_MONICA_BENNETT_001",
    );

    expect(episode2).toEqual(episode3);
    expect(verifyVoiceStability(episode2, episode3)).toBeUndefined();
    expect(bindingFingerprint(episode2)).toBe(bindingFingerprint(episode3));
  });

  it("binding is stable across store reload boundaries (no random re-roll)", async () => {
    const { mem, store } = makeStore();
    await store.create("CHAR_MARCUS_HALE_001", {
      fishVoiceId: "marcus-voice-7",
      model: "s2-pro",
      pace: "slow",
      pronunciationDictionary: [{ term: "Hale", pronunciation: "hayl" }],
      importantProperNouns: ["Marcus Hale"],
    });
    const ep1 = resolveSynthesisBinding(
      await profilesMap(store),
      "CHAR_MARCUS_HALE_001",
    );

    // Fresh store instance over the same persisted file = a "new session".
    const store2 = new VoiceProfileStore({
      filePath: "/tmp/test-voice-binding-profiles.json",
      fs: mem.fs,
    });
    const ep2 = resolveSynthesisBinding(
      await profilesMap(store2),
      "CHAR_MARCUS_HALE_001",
    );
    expect(ep1).toEqual(ep2);
    expect(verifyVoiceStability(ep1, ep2)).toBeUndefined();
  });

  it("unbound character fails loudly instead of picking a random voice", async () => {
    const { store } = makeStore();
    const empty = await profilesMap(store);
    expect(() =>
      resolveSynthesisBinding(empty, "CHAR_GHOST_001"),
    ).toThrow(/No voice profile bound to character CHAR_GHOST_001/);
    expect(() =>
      resolveCastBindings(empty, ["CHAR_GHOST_001"]),
    ).toThrow(/No voice profile bound to character CHAR_GHOST_001/);
  });

  it("cast resolution covers every recurring character in order", async () => {
    const { store } = makeStore();
    await store.create("CHAR_MONICA_BENNETT_001", sampleInput());
    await store.create("CHAR_MARCUS_HALE_001", {
      fishVoiceId: "marcus-voice-7",
      model: "s2-pro",
    });
    const bindings = resolveCastBindings(await profilesMap(store), [
      "CHAR_MONICA_BENNETT_001",
      "CHAR_MARCUS_HALE_001",
    ]);
    expect(bindings.map((b) => b.characterId)).toEqual([
      "CHAR_MONICA_BENNETT_001",
      "CHAR_MARCUS_HALE_001",
    ]);
    expect(resolveCastBindings(await profilesMap(store), [
      "CHAR_MONICA_BENNETT_001",
      "CHAR_MONICA_BENNETT_001",
    ]).map((b) => b.fishVoiceId)).toEqual([
      "54a1e4b0-4a5f-4a1e-9c2f-fishvoice01",
      "54a1e4b0-4a5f-4a1e-9c2f-fishvoice01",
    ]);
  });

  it("explicit update changes the binding and the fingerprint — audited, versioned, never silent", async () => {
    const { store } = makeStore();
    await store.create("CHAR_MONICA_BENNETT_001", sampleInput());
    const ep1 = resolveSynthesisBinding(
      await profilesMap(store),
      "CHAR_MONICA_BENNETT_001",
    );
    // A deliberate recast of the voice (e.g. voice retired by the provider):
    await store.update("CHAR_MONICA_BENNETT_001", {
      fishVoiceId: "monica-voice-v2",
    });
    const ep2 = resolveSynthesisBinding(
      await profilesMap(store),
      "CHAR_MONICA_BENNETT_001",
    );
    const reason = verifyVoiceStability(ep1, ep2);
    expect(reason).toMatch(/fishVoiceId changed/);
    expect(ep2.version).toBe(2);
    expect(bindingFingerprint(ep1)).not.toBe(bindingFingerprint(ep2));
  });

  it("detects every field-level drift with a named reason", () => {
    const base: SynthesisBinding = {
      characterId: "CHAR_A_001",
      fishVoiceId: "v1",
      model: "s2-pro",
      pace: "normal",
      emotionStyle: "warm",
      pronunciationDictionary: [{ term: "Kael", pronunciation: "kayl" }],
      importantProperNouns: ["Kael Rho"],
      version: 1,
    };
    expect(verifyVoiceStability(base, { ...base })).toBeUndefined();
    expect(
      verifyVoiceStability(base, { ...base, fishVoiceId: "v2" }),
    ).toMatch(/fishVoiceId changed/);
    expect(verifyVoiceStability(base, { ...base, model: "s1" })).toMatch(
      /model changed/,
    );
    expect(verifyVoiceStability(base, { ...base, pace: "fast" })).toMatch(
      /pace changed/,
    );
    expect(
      verifyVoiceStability(base, { ...base, emotionStyle: "cold" }),
    ).toMatch(/emotionStyle changed/);
    expect(
      verifyVoiceStability(base, {
        ...base,
        pronunciationDictionary: [
          { term: "Kael", pronunciation: "kail" },
        ],
      }),
    ).toMatch(/pronunciationDictionary changed/);
    expect(
      verifyVoiceStability(base, {
        ...base,
        importantProperNouns: ["Someone Else"],
      }),
    ).toMatch(/importantProperNouns changed/);
    expect(
      verifyVoiceStability(base, { ...base, characterId: "CHAR_B_001" }),
    ).toMatch(/characterId mismatch/);
    // version alone is metadata, not a voice change
    expect(verifyVoiceStability(base, { ...base, version: 9 })).toBeUndefined();
  });

  it("fingerprint is deterministic across key order and process boundaries", () => {
    const a: SynthesisBinding = {
      characterId: "CHAR_A_001",
      fishVoiceId: "v1",
      model: "s2-pro",
      pace: "normal",
      emotionStyle: "",
      pronunciationDictionary: [],
      importantProperNouns: [],
      version: 1,
    };
    const b: SynthesisBinding = { ...a };
    // Same content, different property insertion order.
    const reordered: SynthesisBinding = {
      version: 1,
      importantProperNouns: [],
      pronunciationDictionary: [],
      emotionStyle: "",
      pace: "normal",
      model: "s2-pro",
      fishVoiceId: "v1",
      characterId: "CHAR_A_001",
    };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(bindingFingerprint(a)).toBe(bindingFingerprint(b));
    expect(bindingFingerprint(a)).toBe(bindingFingerprint(reordered));
    expect(stableStringify({ x: 1, y: [1, { z: 2 }] })).toBe(
      stableStringify({ y: [1, { z: 2 }], x: 1 }),
    );
  });
});