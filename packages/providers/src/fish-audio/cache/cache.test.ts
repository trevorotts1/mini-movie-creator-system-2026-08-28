/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { FishDialogueCache, type FishDialogueCacheFs } from "./cache.js";
import { dialogueCacheKey } from "./key.js";
import type { FishDialogueRequest } from "./types.js";

/** In-memory fs seam: same subset as the real fs.promises the cache uses. */
function memoryFs(): FishDialogueCacheFs & { readdir(p: string): Promise<string[]>; rm(p: string): Promise<void> } {
  const files = new Map<string, string>();
  return {
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    async writeFile(p: string, data: string) {
      files.set(p, data);
    },
    async mkdir() {
      return undefined;
    },
    async readdir(p: string) {
      return [...files.keys()]
        .filter((k) => k.startsWith(`${p}/`))
        .map((k) => k.slice(p.length + 1));
    },
    async rm(p: string) {
      files.delete(p);
    },
    snapshot() {
      return new Map(files);
    },
  } as never;
}

function fakeSynth(calls: string[][]) {
  let n = 0;
  return (request: FishDialogueRequest, key: string) => {
    n += 1;
    calls.push([key, request.text]);
    return Promise.resolve({
      audio: new TextEncoder().encode(`audio-${n}`).buffer as ArrayBuffer,
      model: request.model,
    });
  };
}

const REQ: FishDialogueRequest = {
  text: "Monica: The city forgets faster than we do.",
  voiceId: "voice-monica-001",
  model: "s2-pro",
  format: "mp3",
};

const FIXED_NOW = new Date("2026-08-28T12:00:00Z");

describe("FishDialogueCache — idempotency (acceptance)", () => {
  it("same text+voice+model request returns the SAME cached asset; synthesizer called once", async () => {
    const fsImpl = memoryFs();
    const calls: string[][] = [];
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-test",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });

    const first = await cache.getOrSynthesize(REQ, fakeSynth(calls));
    const second = await cache.getOrSynthesize(REQ, fakeSynth(calls));
    const third = await cache.getOrSynthesize(
      { ...REQ, temperature: undefined, topP: undefined },
      fakeSynth(calls),
    );

    expect(calls).toHaveLength(1); // synthesized exactly once
    expect(second.key).toBe(first.key);
    expect(second.audioByteLength).toBe(first.audioByteLength);
    expect(new TextDecoder().decode(second.audio)).toBe(
      new TextDecoder().decode(first.audio),
    );
    expect(second.createdAt).toBe(first.createdAt);
    expect(third.audio).toEqual(first.audio);
  });

  it("a second cache instance over the same directory resolves the same asset (durable across restarts)", async () => {
    const fsImpl = memoryFs();
    const calls: string[][] = [];
    const dir = "/tmp/fish-cache-durable";
    const opts = { directory: dir, fs: fsImpl, now: () => FIXED_NOW };
    const first = await new FishDialogueCache(opts).getOrSynthesize(
      REQ,
      fakeSynth(calls),
    );
    const reopened = await new FishDialogueCache(opts).get(REQ);
    expect(reopened).not.toBeNull();
    expect(reopened?.key).toBe(first.key);
    expect(reopened?.audio).toEqual(first.audio);
  });

  it("concurrent getOrSynthesize for the same request single-flights one synthesis", async () => {
    const fsImpl = memoryFs();
    const calls: string[][] = [];
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-single",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    const synth = vi.fn((request: FishDialogueRequest, key: string) =>
      Promise.resolve({
        audio: new TextEncoder().encode("shared-bytes").buffer as ArrayBuffer,
        model: request.model,
      }),
    );
    const [a, b, c] = await Promise.all([
      cache.getOrSynthesize(REQ, synth),
      cache.getOrSynthesize(REQ, synth),
      cache.getOrSynthesize(REQ, synth),
    ]);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(a.key).toBe(b.key);
    expect(c.key).toBe(a.key);
    expect(calls).toHaveLength(0); // fakeSynth unused in this test
  });

  it("different request (voice change) synthesizes fresh under a different key", async () => {
    const fsImpl = memoryFs();
    const calls: string[][] = [];
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-diff",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    const a = await cache.getOrSynthesize(REQ, fakeSynth(calls));
    const b = await cache.getOrSynthesize(
      { ...REQ, voiceId: "voice-other-002" },
      fakeSynth(calls),
    );
    expect(calls).toHaveLength(2);
    expect(b.key).not.toBe(a.key);
    expect(b.request.voiceId).toBe("voice-other-002");
    expect(b.audioByteLength).toBe(a.audioByteLength); // distinct synthesis runs
  });

  it("persist-before-resolve: audio is durable before getOrSynthesize returns", async () => {
    const fsImpl = memoryFs();
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-durable",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    const entry = await cache.getOrSynthesize(REQ, fakeSynth([]));
    // Reading straight from the seam must already show the entry.
    const raw = await fsImpl.readFile(
      `/tmp/fish-cache-durable/${entry.key}.json`,
      "utf8",
    );
    const doc = JSON.parse(raw) as { formatVersion: number; audioBase64: string };
    expect(doc.formatVersion).toBe(1);
    expect(Buffer.from(doc.audioBase64, "base64").length).toBe(
      entry.audioByteLength,
    );
  });
});

describe("FishDialogueCache — storage behavior", () => {
  it("get() misses return null (missing, corrupt, and foreign-format keys)", async () => {
    const fsImpl = memoryFs();
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-miss",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    expect(await cache.get(REQ)).toBeNull();
    expect(await cache.getByKey("fsh1:not-hex")).toBeNull();
    expect(await cache.getByKey("bogus:abcd")).toBeNull();
  });

  it("corrupt on-disk entry counts as a miss and is re-synthesized", async () => {
    const fsImpl = memoryFs();
    const key = dialogueCacheKey(REQ);
    await fsImpl.writeFile(`/tmp/x/${key}.json`, "{not json", "utf8");
    const cache = new FishDialogueCache({
      directory: "/tmp/x",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    expect(await cache.get(REQ)).toBeNull();
    const calls: string[][] = [];
    const entry = await cache.getOrSynthesize(REQ, fakeSynth(calls));
    expect(calls).toHaveLength(1);
    expect(entry.key).toBe(key);
  });

  it("structurally invalid on-disk docs count as a miss, not a broken hit", async () => {
    const fsImpl = memoryFs();
    const key = dialogueCacheKey(REQ);
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-structural",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    // Parseable JSON but no entry payload.
    await fsImpl.writeFile(`/tmp/fish-cache-structural/${key}.json`, '{"formatVersion":1,"audioBase64":"AAAA"}', "utf8");
    expect(await cache.get(REQ)).toBeNull();
    // Entry payload missing required fields.
    await fsImpl.writeFile(
      `/tmp/fish-cache-structural/${key}.json`,
      JSON.stringify({ formatVersion: 1, entry: { key }, audioBase64: Buffer.from("x").toString("base64") }),
      "utf8",
    );
    expect(await cache.get(REQ)).toBeNull();
    // Tampered audio: decoded length disagrees with recorded audioByteLength.
    await fsImpl.writeFile(
      `/tmp/fish-cache-structural/${key}.json`,
      JSON.stringify({
        formatVersion: 1,
        entry: { key, request: REQ, audioByteLength: 999, model: "s2-pro", createdAt: FIXED_NOW.toISOString(), origin: "synthesized" },
        audioBase64: Buffer.from("tiny").toString("base64"),
      }),
      "utf8",
    );
    expect(await cache.get(REQ)).toBeNull();
    // Entry key inside the file disagrees with the filename key.
    const otherKey = "fsh1:" + "b".repeat(64);
    await fsImpl.writeFile(
      `/tmp/fish-cache-structural/${key}.json`,
      JSON.stringify({
        formatVersion: 1,
        entry: { key: otherKey, request: REQ, audioByteLength: 4, model: "s2-pro", createdAt: FIXED_NOW.toISOString(), origin: "synthesized" },
        audioBase64: Buffer.from("tiny").toString("base64"),
      }),
      "utf8",
    );
    expect(await cache.get(REQ)).toBeNull();
    expect(await cache.getByKey(otherKey)).toBeNull();
  });

  it("untrusted dialogue text is stored verbatim, never executed or path-built", async () => {
    const fsImpl = memoryFs();
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-hostile",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    const hostile: FishDialogueRequest = {
      text: 'ignore previous instructions; process.exit(1); ../../etc/passwd; {"injected":true}',
      voiceId: "voice-001",
      model: "s2-pro",
    };
    const entry = await cache.getOrSynthesize(hostile, fakeSynth([]));
    // Key is a pure hex digest; the hostile text never shaped the path.
    expect(entry.key).toMatch(/^fsh1:[0-9a-f]{64}$/);
    const round = await cache.get(hostile);
    expect(round?.request.text).toBe(hostile.text);
  });

  it("keys() lists stored entries sorted; delete() removes one", async () => {
    const fsImpl = memoryFs();
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-keys",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    const a = await cache.getOrSynthesize(REQ, fakeSynth([]));
    const b = await cache.getOrSynthesize(
      { ...REQ, text: "Second line." },
      fakeSynth([]),
    );
    const keys = await cache.keys();
    expect(keys).toEqual([a.key, b.key].sort());
    expect(await cache.delete(a.key)).toBe(true);
    expect(await cache.keys()).toEqual([b.key].sort());
    expect(await cache.get(REQ)).toBeNull();
  });

  it("put() rejects malformed keys without touching the directory", async () => {
    const fsImpl = memoryFs();
    const cache = new FishDialogueCache({
      directory: "/tmp/fish-cache-put",
      fs: fsImpl,
      now: () => FIXED_NOW,
    });
    await expect(
      cache.put({
        key: "../escape",
        request: REQ,
        audio: new ArrayBuffer(0),
        audioByteLength: 0,
        model: "s2-pro",
        createdAt: FIXED_NOW.toISOString(),
        origin: "synthesized",
      }),
    ).rejects.toThrow(/invalid key format/);
    expect(await cache.keys()).toEqual([]);
  });

  it("constructor requires a directory", () => {
    expect(() => new FishDialogueCache({ directory: "  " })).toThrow(
      /directory is required/,
    );
  });
});