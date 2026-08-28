/// <reference types="node" />
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdempotencyError,
  IdempotencyStore,
  onceOnly,
} from "./once-only.js";
import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./atomic-write.js";
import { canonicalize, requestHash } from "./request-hash.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mmcs-idem-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("writes the full content atomically", async () => {
    const p = join(dir, "nested", "out.txt");
    await atomicWriteFile(p, "hello world");
    expect(await readFile(p, "utf8")).toBe("hello world");
    // no temp litter
    expect(await readdir(join(dir, "nested"))).toEqual(["out.txt"]);
  });

  it("writes binary content byte-exact", async () => {
    const p = join(dir, "bin.dat");
    const bytes = Uint8Array.from([0, 1, 2, 254, 255]);
    await atomicWriteFile(p, bytes);
    const buf = await readFile(p);
    expect([...buf]).toEqual([0, 1, 2, 254, 255]);
  });

  it("overwrites an existing file fully", async () => {
    const p = join(dir, "out.txt");
    await atomicWriteFile(p, "first version of the file");
    await atomicWriteFile(p, "second");
    expect(await readFile(p, "utf8")).toBe("second");
    expect(await readdir(dir)).toEqual(["out.txt"]);
  });

  it("removes temp file when write fails (bad target path)", async () => {
    const badDir = join(dir, "not-a-dir", "deeper");
    // Force failure: create a *file* where a directory component is needed.
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "I am a file, not a directory");
    await expect(atomicWriteFile(join(badDir, "x.txt"), "data")).rejects.toThrow();
    // no .tmp litter anywhere under dir
    const entries = await readdir(dir);
    expect(entries.every((e) => !e.endsWith(".tmp"))).toBe(true);
  });

  it("atomicWriteJson writes parseable JSON", async () => {
    const p = join(dir, "data.json");
    await atomicWriteJson(p, { a: 1, b: ["x", "y"] });
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("readJsonFile returns fallback for missing file", async () => {
    const { value, defaulted } = await readJsonFile(join(dir, "missing.json"), { fallback: 42 });
    expect(value).toEqual({ fallback: 42 });
    expect(defaulted).toBe(true);
  });

  it("readJsonFile throws on corrupt content rather than swallowing it", async () => {
    const p = join(dir, "corrupt.json");
    await writeFile(p, "{ not json !!!");
    await expect(readJsonFile(p, null)).rejects.toThrow();
  });
});

describe("requestHash", () => {
  it("is stable regardless of key order", () => {
    const a = requestHash("scope", { provider: "agnes", model: "flash", n: 1 });
    const b = requestHash("scope", { n: 1, model: "flash", provider: "agnes" });
    expect(a).toBe(b);
  });

  it("differs across scopes and request content", () => {
    const req = { prompt: "hello" };
    expect(requestHash("agnes-image", req)).not.toBe(requestHash("kie-video", req));
    expect(requestHash("s", { a: 1 })).not.toBe(requestHash("s", { a: 2 }));
  });

  it("treats missing and undefined uniformly, respects null", () => {
    expect(canonicalize({ a: undefined })).toBe(canonicalize({}));
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it("handles nested objects and arrays deterministically", () => {
    const x = { list: [{ z: 1, a: 2 }, [3, { b: 4 }]] };
    const y = { list: [{ a: 2, z: 1 }, [3, { b: 4 }]] };
    expect(requestHash("s", x)).toBe(requestHash("s", y));
  });

  it("honors requested length truncation", () => {
    expect(requestHash("s", { a: 1 }, { length: 16 })).toHaveLength(16);
  });
});

describe("IdempotencyStore — once-only execution", () => {
  it("executes once; duplicate submit returns the original result", async () => {
    const store = new IdempotencyStore(dir);
    const request = { episode: 3, shot: 5, prompt: "sunset over harbor" };
    let calls = 0;
    const first = await onceOnly(store, "agnes-image", request, async () => {
      calls += 1;
      return { imageUrl: "https://example.com/img.png", cost: 0.04 };
    });
    expect(first.reused).toBe(false);
    expect(calls).toBe(1);

    // Duplicate submit attempt — different fn, must NOT run.
    const dup = await onceOnly(store, "agnes-image", request, async () => {
      calls += 1;
      throw new Error("expensive generation must not re-run");
    });
    expect(calls).toBe(1);
    expect(dup.reused).toBe(true);
    expect(dup.value).toEqual({ imageUrl: "https://example.com/img.png", cost: 0.04 });
  });

  it("different requests in the same scope get separate executions", async () => {
    const store = new IdempotencyStore(dir);
    let calls = 0;
    await onceOnly(store, "scope", { a: 1 }, async () => ++calls);
    await onceOnly(store, "scope", { a: 2 }, async () => ++calls);
    expect(calls).toBe(2);
  });

  it("serializes concurrent same-key calls into one execution", async () => {
    const store = new IdempotencyStore(dir);
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        onceOnly(store, "kie-video", { prompt: "race" }, async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return { jobId: "job-123", calls: calls };
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.value.jobId))).toEqual(new Set(["job-123"]));
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(results.filter((r) => r.reused)).toHaveLength(4);
  });

  it("suffix option separates keys for same request", async () => {
    const store = new IdempotencyStore(dir);
    let calls = 0;
    const fn = async () => ++calls;
    await onceOnly(store, "s", { r: 1 }, fn);
    await onceOnly(store, "s", { r: 1 }, fn, { suffix: "attempt-2" });
    expect(calls).toBe(2);
    await onceOnly(store, "s", { r: 1 }, fn, { suffix: "attempt-2" });
    expect(calls).toBe(2);
  });

  it("get returns null for unknown key and the record for a known one", async () => {
    const store = new IdempotencyStore(dir);
    const key = store.keyFor("scope", { a: 1 });
    expect(await store.get(key)).toBeNull();
    await store.execute("scope", { a: 1 }, async () => "result");
    const rec = await store.get<{ result: string }>(key);
    expect(rec?.result).toBe("result");
    expect(rec?.scope).toBe("scope");
    expect(rec?.requestHash).toBe(requestHash("scope", { a: 1 }));
  });

  it("rejects directory-traversal keys", async () => {
    const store = new IdempotencyStore(dir);
    await expect(store.get("../escape")).rejects.toThrow(/invalid idempotency key/);
  });

  it("constructor requires a dir", () => {
    expect(() => new IdempotencyStore("")).toThrow(/dir is required/);
  });

  it("sweepTempFiles removes crash litter", async () => {
    const store = new IdempotencyStore(dir);
    await writeFile(join(dir, "abc.123.999.deadbeef.tmp"), "partial");
    await writeFile(join(dir, "keep.json"), "{}");
    expect(await store.sweepTempFiles()).toBe(1);
    const entries = await readdir(dir);
    expect(entries).toEqual(["keep.json"]);
    expect(await store.sweepTempFiles()).toBe(0);
  });

  it("normalizes undefined results and flags non-serializable ones", async () => {
    const store = new IdempotencyStore(dir);
    const r1 = await onceOnly(store, "s", { k: 1 }, async () => undefined);
    expect(r1.value).toBeUndefined();
    expect((await store.get(store.keyFor("s", { k: 1 })))?.result).toBeNull();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r2 = await onceOnly(store, "s", { k: 2 }, async () => circular);
    // Original call still completes (fn ran); the recorded value is null and
    // the duplicate path raises instead of silently returning null.
    expect(r2.value).toBeNull();
    expect(r2.reused).toBe(false);
    const rec = await store.get(store.keyFor("s", { k: 2 }));
    expect(rec?.serializationError).toBeTruthy();
    await expect(
      onceOnly(store, "s", { k: 2 }, async () => "should not run"),
    ).rejects.toThrow(IdempotencyError);
  });
});

describe("crash-mid-write resilience", () => {
  it("simulated crash during result write leaves no partial record; retry succeeds", async () => {
    const store = new IdempotencyStore(dir);
    const key = store.keyFor("kie-video", { prompt: "crash test" });

    // Simulate a crash exactly between temp-file creation and rename:
    // a temp file with partial JSON exists, target record does not.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.pid.time.rand.tmp`), '{"key":"partial');
    // Also simulate a fully-renamed but truncated record (external damage path)
    // is NOT what atomic write produces; instead confirm a pre-rename crash
    // means the key is simply absent.
    expect(await store.get(key)).toBeNull();

    // Post-crash retry executes fresh and records the result atomically.
    const r = await onceOnly(store, "kie-video", { prompt: "crash test" }, async () => ({
      taskId: "kie-task-777",
    }));
    expect(r.reused).toBe(false);
    expect(r.value).toEqual({ taskId: "kie-task-777" });

    // And the duplicate after recovery returns the original result.
    const dup = await onceOnly(store, "kie-video", { prompt: "crash test" }, async () => {
      throw new Error("must not re-run");
    });
    expect(dup.reused).toBe(true);
    expect(dup.value).toEqual({ taskId: "kie-task-777" });

    // Temp litter was not mistaken for a record and can be swept.
    expect(await store.sweepTempFiles()).toBe(1);
  });

  it("record write is atomic under injected mid-write failure: target never partial", async () => {
    const store = new IdempotencyStore(dir);
    const key = store.keyFor("scope", { q: 1 });
    const target = join(dir, `${key}.json`);

    // Seed a good record first.
    await store.execute("scope", { q: 1 }, async () => "v1");
    const before = await readFile(target, "utf8");

    // Now make rename fail by making the store dir unwritable — a real-world
    // stand-in for a crash before rename — and prove the existing record is
    // untouched: a failed write cannot corrupt prior state.
    await chmod(dir, 0o555);
    try {
      await expect(
        store.put({ key, scope: "scope", requestHash: "h", createdAt: "t", result: "v2" }),
      ).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }
    // Original record intact and parseable.
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(JSON.parse(before));
    // And the store still serves the original result.
    const dup = await onceOnly(store, "scope", { q: 1 }, async () => {
      throw new Error("must not re-run");
    });
    expect(dup.value).toBe("v1");
    vi.restoreAllMocks();
  });

  it("process-level crash between fn and record write re-runs on restart (documented semantics)", async () => {
    // The guard is directory-backed: if the process dies after fn() but before
    // the atomic record lands, the key is absent on restart and fn re-runs.
    // fn must be safe-to-retry (provider-side idempotency key) — assert the
    // mechanism: no record exists if put() never completed.
    const store = new IdempotencyStore(dir);
    const spy = vi
      .spyOn(store, "put")
      .mockRejectedValue(new Error("process died before record landed"));
    await expect(
      store.execute("scope", { z: 9 }, async () => "ran"),
    ).rejects.toThrow("process died before record landed");
    expect(await store.get(store.keyFor("scope", { z: 9 }))).toBeNull();
    spy.mockRestore();
    // Restart path: executes again and records.
    const r = await store.execute("scope", { z: 9 }, async () => "ran-again");
    expect(r.reused).toBe(false);
    expect(r.record.result).toBe("ran-again");
  });
});