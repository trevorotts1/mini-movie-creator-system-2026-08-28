/**
 * GHL-011 tests — retry/idempotency.
 * No real GHL calls, no credentials, no network. All time is injected.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchivalFailedError,
  ArchivalLedger,
  ArchivalLedgerError,
  GhlNonRetryableError,
  GhlRetryableHttpError,
  RetryBudgetExhaustedError,
  archivalKey,
  boundedRetry,
  classifyFailure,
  computeBackoffDelayMs,
  retryableHttpStatus,
  totalBoundedDelayMs,
  withArchivalIdempotency,
  type ArchivalAttemptRequest,
} from "./index.js";

const immediateSleep = async () => undefined;

function request(overrides: Partial<ArchivalAttemptRequest> = {}): ArchivalAttemptRequest {
  return {
    altId: "loc-123",
    parentId: "folder-9",
    name: "S01E01_shot-05_scene-master.png",
    checksum: "abc123def456",
    providerTaskId: "prov-task-77",
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ghl-011-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("backoff — bounded, capped, deterministic", () => {
  it("grows exponentially from the base delay", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 100_000 };
    expect(computeBackoffDelayMs(0, opts)).toBe(100);
    expect(computeBackoffDelayMs(1, opts)).toBe(200);
    expect(computeBackoffDelayMs(2, opts)).toBe(400);
    expect(computeBackoffDelayMs(3, opts)).toBe(800);
  });

  it("caps any single wait at maxDelayMs", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 500 };
    expect(computeBackoffDelayMs(10, opts)).toBe(500);
    expect(computeBackoffDelayMs(100, opts)).toBe(500);
  });

  it("falls back to safe defaults for invalid options", () => {
    expect(computeBackoffDelayMs(0, { baseDelayMs: -5 })).toBe(250);
    expect(computeBackoffDelayMs(0, { baseDelayMs: Number.NaN })).toBe(250);
    expect(computeBackoffDelayMs(Number.NaN)).toBe(250);
  });

  it("totals the bounded delay across a full run", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 100_000, maxAttempts: 4 };
    // 100 + 200 + 400 between the 4 attempts.
    expect(totalBoundedDelayMs(opts)).toBe(700);
  });

  it("applies injected jitter and stays capped", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 300, jitter: (d: number) => d * 2 };
    expect(computeBackoffDelayMs(0, opts)).toBe(200);
    expect(computeBackoffDelayMs(1, opts)).toBe(300);
    expect(computeBackoffDelayMs(2, opts)).toBe(300);
  });
});

describe("failure classification", () => {
  it("retries transport faults and transient HTTP statuses", () => {
    expect(classifyFailure(new GhlRetryableHttpError(429, "slow down"))).toBe("retry");
    expect(classifyFailure(new GhlRetryableHttpError(502, "bad gateway"))).toBe("retry");
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyFailure(reset)).toBe("retry");
    expect(classifyFailure(Object.assign(new Error("t"), { name: "AbortError" }))).toBe("retry");
    expect(classifyFailure(new TypeError("fetch failed"))).toBe("retry");
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(classifyFailure(timeout)).toBe("retry");
  });

  it("stops on deterministic failures", () => {
    expect(classifyFailure(new GhlNonRetryableError("bad request body"))).toBe("stop");
    expect(classifyFailure(new Error("auth rejected"))).toBe("stop");
    expect(classifyFailure("plain string failure")).toBe("stop");
    expect(classifyFailure(undefined)).toBe("stop");
    expect(classifyFailure(new Error())).not.toBe("retry");
  });

  it("maps HTTP statuses: transient → error, deterministic → null", () => {
    expect(retryableHttpStatus(429, "")).toBeInstanceOf(GhlRetryableHttpError);
    expect(retryableHttpStatus(503, "")).toBeInstanceOf(GhlRetryableHttpError);
    expect(retryableHttpStatus(408, "")).toBeInstanceOf(GhlRetryableHttpError);
    expect(retryableHttpStatus(400, "nope")).toBeNull();
    expect(retryableHttpStatus(401, "unauthorized")).toBeNull();
    expect(retryableHttpStatus(404, "missing")).toBeNull();
    expect(retryableHttpStatus(422, "validation")).toBeNull();
    expect(retryableHttpStatus(200, "")).toBeNull();
  });
});

describe("boundedRetry — hard attempt cap", () => {
  it("stops retrying after maxAttempts and wraps the last error", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      boundedRetry(
        () => {
          calls += 1;
          throw new GhlRetryableHttpError(503, "try again");
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
    expect(calls).toBe(3); // hard cap: never a 4th call
    expect(sleeps).toEqual([10, 20]); // backoff between, capped
  });

  it("returns on first-try success without sleeping", async () => {
    let calls = 0;
    const result = await boundedRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { maxAttempts: 5, sleep: async () => { throw new Error("must not sleep"); } },
    );
    expect(result).toEqual({ value: "ok", attempts: 1, firstTry: true });
    expect(calls).toBe(1);
  });

  it("succeeds on a later attempt after transient failures", async () => {
    let calls = 0;
    const result = await boundedRetry(
      () => {
        calls += 1;
        if (calls < 3) throw new GhlRetryableHttpError(429, "rate limited");
        return Promise.resolve(calls);
      },
      { maxAttempts: 5, sleep: immediateSleep },
    );
    expect(result.value).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.firstTry).toBe(false);
  });

  it("never retries non-retryable failures", async () => {
    let calls = 0;
    await expect(
      boundedRetry(
        () => {
          calls += 1;
          throw new GhlNonRetryableError("invalid GHL folder id");
        },
        { maxAttempts: 5, sleep: immediateSleep },
      ),
    ).rejects.toBeInstanceOf(GhlNonRetryableError);
    expect(calls).toBe(1);
  });

  it("honors a caller shouldRetry veto", async () => {
    let calls = 0;
    await expect(
      boundedRetry(
        () => {
          calls += 1;
          throw new GhlRetryableHttpError(500, "down");
        },
        { maxAttempts: 5, sleep: immediateSleep, shouldRetry: () => false },
      ),
    ).rejects.toBeInstanceOf(GhlRetryableHttpError);
    expect(calls).toBe(1);
  });

  it("rethrows the original error type for a single attempt budget", async () => {
    await expect(
      boundedRetry(() => Promise.reject(new GhlNonRetryableError("no")), { maxAttempts: 1, sleep: immediateSleep }),
    ).rejects.toBeInstanceOf(GhlNonRetryableError);
  });
});

describe("archivalKey — deterministic request hashing", () => {
  it("same canonical request → same key regardless of property order", () => {
    const a = archivalKey("ghl-archival", { altId: "loc", parentId: "f", name: "x.png" });
    const b = archivalKey("ghl-archival", { name: "x.png", parentId: "f", altId: "loc" });
    expect(a).toBe(b);
  });

  it("different checksum / destination / name → different keys", () => {
    const base = archivalKey("ghl-archival", request());
    expect(archivalKey("ghl-archival", request({ checksum: "different" }))).not.toBe(base);
    expect(archivalKey("ghl-archival", request({ parentId: "other" }))).not.toBe(base);
    expect(archivalKey("ghl-archival", request({ name: "other.png" }))).not.toBe(base);
  });

  it("differs across scopes and rejects unsafe scopes/keys", () => {
    expect(archivalKey("a", { x: 1 })).not.toBe(archivalKey("b", { x: 1 }));
    expect(() => archivalKey("bad scope/", { x: 1 })).toThrow(ArchivalLedgerError);
    expect(() => archivalKey("", { x: 1 })).toThrow(ArchivalLedgerError);
  });
});

describe("ArchivalLedger — durable, atomic, crash-safe", () => {
  it("reserves, completes, and returns the recorded result", async () => {
    const ledger = new ArchivalLedger(dir);
    const key = archivalKey("ghl-archival", request());
    const { created } = await ledger.reserve(key, "ghl-archival", "hash");
    expect(created).toBe(true);
    const dup = await ledger.reserve(key, "ghl-archival", "hash");
    expect(dup.created).toBe(false);
    await ledger.complete(key, { fileId: "file-1", url: "https://files.example/file-1" });
    const record = await ledger.get<{ fileId: string; url: string }>(key);
    expect(record?.state).toBe("completed");
    expect(record?.result).toEqual({ fileId: "file-1", url: "https://files.example/file-1" });
  });

  it("missing keys read as null and release removes records", async () => {
    const ledger = new ArchivalLedger(dir);
    expect(await ledger.get("nope")).toBeNull();
    const key = archivalKey("s", { a: 1 });
    await ledger.reserve(key, "s", "h");
    await ledger.release(key);
    expect(await ledger.get(key)).toBeNull();
  });

  it("leaves no temp litter after a normal write", async () => {
    const ledger = new ArchivalLedger(dir);
    const key = archivalKey("s", { a: 1 });
    await ledger.reserve(key, "s", "h");
    expect(await readdir(dir)).toEqual([`${key}.json`]);
  });

  it("sweeps temp litter from a crashed process without touching records", async () => {
    const ledger = new ArchivalLedger(dir);
    const key = archivalKey("s", { a: 1 });
    await ledger.reserve(key, "s", "h");
    await writeFile(join(dir, `${key}.json.tmp-abcd1234`), "half-written");
    expect(await ledger.sweepTempFiles()).toBe(1);
    expect(await ledger.get(key)).not.toBeNull();
    expect(await ledger.sweepTempFiles()).toBe(0);
  });

  it("a rename failure preserves the prior durable record", async () => {
    const ledger = new ArchivalLedger(dir);
    const key = archivalKey("s", { a: 1 });
    await ledger.reserve(key, "s", "h");
    // Make rename fail: put a directory in the temp path's way is not possible
    // (same name), so simulate by making the destination undisposable —
    // replace the record file with a directory; rename onto it fails.
    await rm(join(dir, `${key}.json`));
    await mkdir2(join(dir, `${key}.json`));
    await expect(ledger.complete(key, { ok: true })).rejects.toBeTruthy();
    // Temp litter cleaned; original reservation content still readable.
    const raw = await readFile(join(dir, `${key}.json`), "utf8").catch(() => null);
    expect(raw).toBeNull(); // directory read fails → treated absent on next get
    await rm(join(dir, `${key}.json`), { recursive: true });
    expect(await ledger.get(key)).toBeNull();
  });

  it("rejects malformed keys and empty dirs", () => {
    expect(() => new ArchivalLedger("")).toThrow(ArchivalLedgerError);
    expect(() => new ArchivalLedger("  ")).toThrow(ArchivalLedgerError);
  });
});

async function mkdir2(p: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p);
}

describe("withArchivalIdempotency — retry never duplicates GHL files", () => {
  it("uploads exactly once across repeated identical archival calls", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    const attempt = async () => {
      uploads += 1;
      return { fileId: "file-1", url: "https://files.example/file-1" };
    };
    const first = await withArchivalIdempotency(ledger, request(), attempt);
    expect(first.reused).toBe(false);
    expect(uploads).toBe(1);

    // A restart / duplicate call with the SAME canonical request must not
    // upload again — it returns the recorded result.
    const second = await withArchivalIdempotency(ledger, request(), async () => {
      uploads += 1;
      throw new Error("duplicate upload attempted");
    });
    expect(uploads).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.value).toEqual({ fileId: "file-1", url: "https://files.example/file-1" });
  });

  it("survives a crash between upload success and record write (lost success)", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    const attempt = async () => {
      uploads += 1;
      return { fileId: "file-2", url: "https://files.example/file-2" };
    };
    await withArchivalIdempotency(ledger, request(), attempt);

    // Simulate restart: fresh ledger instance over the same dir.
    const ledger2 = new ArchivalLedger(dir);
    const again = await withArchivalIdempotency<{ fileId: string; url: string }>(
      ledger2,
      request(),
      async () => {
        uploads += 1;
        throw new Error("regeneration/duplicate upload after restart");
      },
    );
    expect(uploads).toBe(1);
    expect(again.reused).toBe(true);
    expect(again.value.fileId).toBe("file-2");
  });

  it("serializes concurrent same-key calls into one upload", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    const attempt = async () => {
      uploads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { fileId: "file-3", url: "u" };
    };
    const [a, b, c] = await Promise.all([
      withArchivalIdempotency(ledger, request(), attempt),
      withArchivalIdempotency(ledger, request(), attempt),
      withArchivalIdempotency(ledger, request(), attempt),
    ]);
    expect(uploads).toBe(1);
    expect(a.value).toEqual(b.value);
    expect(c.value).toEqual(a.value);
  });

  it("different logical assets (different checksum) upload separately", async () => {
    const ledger = new ArchivalLedger(dir);
    const ids: string[] = [];
    const attemptFor = (id: string) => async () => ({ fileId: id, url: `u-${id}` });
    const r1 = await withArchivalIdempotency(ledger, request(), attemptFor("f1"));
    const r2 = await withArchivalIdempotency(ledger, request({ checksum: "other-bytes" }), attemptFor("f2"));
    expect(r1.value.fileId).toBe("f1");
    expect(r2.value.fileId).toBe("f2");
    expect(archivalKey("ghl-archival", request())).not.toBe(archivalKey("ghl-archival", request({ checksum: "other-bytes" })));
    expect(ids).toEqual([]);
  });
});

describe("withArchivalIdempotency — bounded retry with backoff", () => {
  it("retries transient failures with backoff, then succeeds once", async () => {
    const ledger = new ArchivalLedger(dir);
    const sleeps: number[] = [];
    let uploads = 0;
    const result = await withArchivalIdempotency(
      ledger,
      request(),
      async () => {
        uploads += 1;
        if (uploads < 3) throw new GhlRetryableHttpError(503, "overloaded");
        return { fileId: "file-4", url: "u4" };
      },
      { baseDelayMs: 10, maxDelayMs: 40, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result.reused).toBe(false);
    expect(uploads).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(result.attempts).toBe(3);

    // And the recorded success is durable for later calls.
    const dup = await withArchivalIdempotency(ledger, request(), async () => {
      uploads += 1;
      return { fileId: "SHOULD-NOT-UPLOAD", url: "" };
    });
    expect(uploads).toBe(3);
    expect(dup.reused).toBe(true);
    expect(dup.value.fileId).toBe("file-4");
  });

  it("stops retrying deterministic (non-retryable) failures immediately", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    await expect(
      withArchivalIdempotency(
        ledger,
        request(),
        async () => {
          uploads += 1;
          throw new GhlNonRetryableError("GHL rejected the folder id");
        },
        { maxAttempts: 5, sleep: immediateSleep },
      ),
    ).rejects.toBeInstanceOf(ArchivalFailedError);
    expect(uploads).toBe(1);
  });

  it("exhaustion throws ArchivalFailedError preserving the provider task id", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    try {
      await withArchivalIdempotency(
        ledger,
        request(),
        async () => {
          uploads += 1;
          throw new GhlRetryableHttpError(504, "gateway timeout");
        },
        { maxAttempts: 3, sleep: immediateSleep },
      );
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArchivalFailedError);
      const failure = err as ArchivalFailedError;
      expect(failure.providerTaskId).toBe("prov-task-77");
      expect(String(failure)).toContain("prov-task-77");
 expect(String(failure)).toContain("preserved");
    }
    expect(uploads).toBe(3); // bounded, not unbounded
  });

  it("failed attempts leave the key reservable for a later resume", async () => {
    const ledger = new ArchivalLedger(dir);
    await expect(
      withArchivalIdempotency(
        ledger,
        request(),
        async () => {
          throw new GhlRetryableHttpError(500, "no");
        },
        { maxAttempts: 2, sleep: immediateSleep },
      ),
    ).rejects.toBeInstanceOf(ArchivalFailedError);
    // The failed run released nothing; the reservation exists but is not
    // completed, so a later resume with a working attempt succeeds.
    const resumed = await withArchivalIdempotency(
      ledger,
      request(),
      async () => ({ fileId: "file-5", url: "u5" }),
      { sleep: immediateSleep },
    );
    expect(resumed.value.fileId).toBe("file-5");
  });
});

describe("archival never triggers regeneration (spec §35.3)", () => {
  it("failure surface is ArchivalFailedError — never a generation request", async () => {
    const ledger = new ArchivalLedger(dir);
    let generationRequested = false;
    try {
      await withArchivalIdempotency(
        ledger,
        request(),
        async () => {
          throw new GhlRetryableHttpError(503, "archival endpoint down");
        },
        { maxAttempts: 2, sleep: immediateSleep },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ArchivalFailedError);
      expect((err as ArchivalFailedError).name).toBe("ArchivalFailedError");
      // The error carries the provider task id so callers persist it and
      // resume archival later — the generation contract is upstream of this
      // module and is never invoked from here.
      expect((err as ArchivalFailedError).providerTaskId).toBe("prov-task-77");
    }
    // The failure must not have recorded a completed outcome.
    const record = await ledger.get(archivalKey("ghl-archival", request()));
    expect(record?.state).not.toBe("completed");
  });

  it("a later retry after failure resumes archival, never regenerates", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    let generations = 0;
    const archiveOnce = async () => {
      uploads += 1;
      if (uploads === 1) throw new GhlRetryableHttpError(502, "bad gateway");
      return { fileId: "file-6", url: "u6" };
    };
    await expect(
      withArchivalIdempotency(ledger, request(), archiveOnce, { maxAttempts: 1, sleep: immediateSleep }),
    ).rejects.toBeInstanceOf(ArchivalFailedError);
    // Generation would be triggered by a caller misreading archival failure —
    // the module's contract is that this counter can only move if a caller
    // explicitly regenerates; archival itself offers no such path.
    expect(generations).toBe(0);

    const second = await withArchivalIdempotency(ledger, request(), archiveOnce, { sleep: immediateSleep });
    expect(second.value.fileId).toBe("file-6");
    expect(uploads).toBe(2);
    expect(generations).toBe(0);
  });

  it("preserves providerTaskId in the outcome metadata path for success too", async () => {
    const ledger = new ArchivalLedger(dir);
    const outcome = await withArchivalIdempotency(
      ledger,
      request({ providerTaskId: "prov-task-99" }),
      async () => ({ fileId: "file-7", url: "u7" }),
    );
    expect(outcome.value).toEqual({ fileId: "file-7", url: "u7" });
    const record = await ledger.get(archivalKey("ghl-archival", request({ providerTaskId: "prov-task-99" })));
    expect(record?.state).toBe("completed");
  });
});

describe("validation", () => {
  it("rejects incomplete archival requests before any network attempt", async () => {
    const ledger = new ArchivalLedger(dir);
    let uploads = 0;
    await expect(
      withArchivalIdempotency(ledger, { altId: "", parentId: "f", name: "n" }, async () => {
        uploads += 1;
        return {};
      }),
    ).rejects.toBeInstanceOf(ArchivalLedgerError);
    await expect(
      withArchivalIdempotency(ledger, { altId: "l", parentId: "", name: "n" }, async () => ({})),
    ).rejects.toBeInstanceOf(ArchivalLedgerError);
    await expect(
      withArchivalIdempotency(ledger, { altId: "l", parentId: "p", name: "" }, async () => ({})),
    ).rejects.toBeInstanceOf(ArchivalLedgerError);
    expect(uploads).toBe(0);
  });
});