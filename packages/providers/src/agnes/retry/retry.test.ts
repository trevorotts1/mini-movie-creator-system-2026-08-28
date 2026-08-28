/**
 * AGN-010 tests — Agnes retry/idempotency.
 * No real Agnes calls, no credentials, no network. All time is injected.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgnesNonRetryableError,
  AgnesRetryableHttpError,
  AgnesSubmitFailedError,
  AgnesSubmitIdempotencyError,
  DEFAULT_BACKOFF,
  RetryBudgetExhaustedError,
  agnesSubmitKey,
  boundedRetry,
  classifyFailure,
  computeBackoffDelayMs,
  resolveBackoff,
  retryableHttpStatus,
  totalBoundedDelayMs,
  validateAgnesSubmitRequest,
  withSubmitIdempotency,
  type AgnesSubmitRequest,
} from "./index.js";
import { IdempotencyStore, type IdempotencyRecord } from "@mmcs/core/idempotency";
import type { AgnesSubmitRecord } from "./submit-idempotency.js";

const immediateSleep = async () => undefined;

function request(overrides: Partial<AgnesSubmitRequest> = {}): AgnesSubmitRequest {
  return {
    model: "agnes-video-2.5-flash",
    prompt: "a detective walks through neon rain",
    jobRef: "shot-05:keyframe-a",
    seconds: "5",
    size: "720P",
    aspect_ratio: "16:9",
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agn-010-"));
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
    expect(computeBackoffDelayMs(0, { baseDelayMs: -5 })).toBe(DEFAULT_BACKOFF.baseDelayMs);
    expect(computeBackoffDelayMs(0, { baseDelayMs: Number.NaN })).toBe(DEFAULT_BACKOFF.baseDelayMs);
    expect(computeBackoffDelayMs(Number.NaN)).toBe(DEFAULT_BACKOFF.baseDelayMs);
  });

  it("forces maxAttempts to at least 1", () => {
    // Invalid values fall back to the safe default; a fractional value is
    // floored then clamped to >= 1.
    expect(resolveBackoff({ maxAttempts: 0 }).maxAttempts).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(resolveBackoff({ maxAttempts: -3 }).maxAttempts).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(resolveBackoff({ maxAttempts: 0.5 }).maxAttempts).toBe(1);
    expect(resolveBackoff({ maxAttempts: 2.9 }).maxAttempts).toBe(2);
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

  it("never unbounds via a misbehaving jitter source", () => {
    // Non-finite jitter falls back to the deterministic capped delay; finite
    // jitter is clamped under the cap.
    const inf = { baseDelayMs: 100, maxDelayMs: 500, jitter: () => Number.POSITIVE_INFINITY };
    expect(computeBackoffDelayMs(0, inf)).toBe(100);
    const nan = { baseDelayMs: 100, maxDelayMs: 500, jitter: () => Number.NaN };
    expect(computeBackoffDelayMs(0, nan)).toBe(100);
    const over = { baseDelayMs: 100, maxDelayMs: 500, jitter: () => 900 };
    expect(computeBackoffDelayMs(0, over)).toBe(500);
  });
});

describe("failure classification", () => {
  it("retries transport faults and transient HTTP statuses", () => {
    expect(classifyFailure(new AgnesRetryableHttpError(429, "slow down"))).toBe("retry");
    expect(classifyFailure(new AgnesRetryableHttpError(502, "bad gateway"))).toBe("retry");
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyFailure(reset)).toBe("retry");
    expect(classifyFailure(Object.assign(new Error("t"), { name: "AbortError" }))).toBe("retry");
    expect(classifyFailure(new TypeError("fetch failed"))).toBe("retry");
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(classifyFailure(timeout)).toBe("retry");
  });

  it("stops on deterministic failures", () => {
    expect(classifyFailure(new AgnesNonRetryableError("bad request body"))).toBe("stop");
    expect(classifyFailure(new Error("auth rejected"))).toBe("stop");
    expect(classifyFailure("plain string failure")).toBe("stop");
    expect(classifyFailure(undefined)).toBe("stop");
  });

  it("maps only transient statuses to retryable errors", () => {
    expect(retryableHttpStatus(429, "x")).toBeInstanceOf(AgnesRetryableHttpError);
    expect(retryableHttpStatus(503, "x")).toBeInstanceOf(AgnesRetryableHttpError);
    expect(retryableHttpStatus(400, "x")).toBeNull();
    expect(retryableHttpStatus(401, "x")).toBeNull();
    expect(retryableHttpStatus(501, "x")).toBeNull();
    expect(retryableHttpStatus(200, "x")).toBeNull();
  });
});

describe("boundedRetry — bounded by maxAttempts (spec §29)", () => {
  it("succeeds on the first try without sleeping", async () => {
    const sleeps: number[] = [];
    const result = await boundedRetry(
      async () => "ok",
      { baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toEqual({ value: "ok", attempts: 1, firstTry: true });
    expect(sleeps).toEqual([]);
  });

  it("retries a transient failure and succeeds", async () => {
    let calls = 0;
    const result = await boundedRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new AgnesRetryableHttpError(503, "overloaded");
        return "third try";
      },
      { baseDelayMs: 10, maxDelayMs: 20, sleep: immediateSleep },
    );
    expect(calls).toBe(3);
    expect(result.value).toBe("third try");
    expect(result.attempts).toBe(3);
    expect(result.firstTry).toBe(false);
  });

  it("NEVER exceeds maxAttempts even when every attempt fails (no unbounded loop)", async () => {
    let calls = 0;
    await expect(
      boundedRetry(
        async () => {
          calls += 1;
          throw new AgnesRetryableHttpError(429, "always");
        },
        { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 5, sleep: immediateSleep },
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
    expect(calls).toBe(5);
  });

  it("does not retry non-retryable failures", async () => {
    let calls = 0;
    await expect(
      boundedRetry(
        async () => {
          calls += 1;
          throw new AgnesNonRetryableError("400: size must be 720P");
        },
        { baseDelayMs: 1, sleep: immediateSleep },
      ),
    ).rejects.toThrowError(AgnesNonRetryableError);
    expect(calls).toBe(1);
  });

  it("honors a vetoing shouldRetry predicate", async () => {
    let calls = 0;
    await expect(
      boundedRetry(
        async () => {
          calls += 1;
          throw new AgnesRetryableHttpError(429, "rate limited");
        },
        { baseDelayMs: 1, sleep: immediateSleep, shouldRetry: () => false },
      ),
    ).rejects.toBeInstanceOf(AgnesRetryableHttpError);
    expect(calls).toBe(1);
  });

  it("wraps exhaustion in RetryBudgetExhaustedError with the last error", async () => {
    let calls = 0;
    try {
      await boundedRetry(
        async () => {
          calls += 1;
          throw new AgnesRetryableHttpError(504, "gateway timeout");
        },
        { maxAttempts: 3, sleep: immediateSleep },
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RetryBudgetExhaustedError);
      expect((err as RetryBudgetExhaustedError).attempts).toBe(3);
      expect((err as RetryBudgetExhaustedError).lastError).toBeInstanceOf(AgnesRetryableHttpError);
    }
    expect(calls).toBe(3);
  });
});

describe("withSubmitIdempotency — same request hash never double-submits", () => {
  it("submits once and records the provider job id", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    const outcome = await withSubmitIdempotency(
      store,
      request(),
      async () => {
        submits += 1;
        return { providerJobId: "vid_123", result: { status: "queued" } };
      },
      { sleep: immediateSleep },
    );
    expect(submits).toBe(1);
    expect(outcome.providerJobId).toBe("vid_123");
    expect(outcome.reused).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(outcome.record.state).toBe("completed");
  });

  it("returns the RECORDED job id for a duplicate of the same request (no resubmit)", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    const submit = async () => {
      submits += 1;
      return { providerJobId: `vid_${submits}` };
    };

    const first = await withSubmitIdempotency(store, request(), submit, { sleep: immediateSleep });
    const second = await withSubmitIdempotency(store, request(), submit, { sleep: immediateSleep });
    const third = await withSubmitIdempotency(
      store,
      // Same logical request, different key insertion order — canonical hash
      // must fold them together.
      { aspect_ratio: "16:9", jobRef: "shot-05:keyframe-a", model: "agnes-video-2.5-flash", prompt: "a detective walks through neon rain", seconds: "5", size: "720P" },
      submit,
      { sleep: immediateSleep },
    );

    expect(submits).toBe(1); // never double-submitted
    expect(first.providerJobId).toBe("vid_1");
    expect(second.providerJobId).toBe("vid_1");
    expect(third.providerJobId).toBe("vid_1");
    expect(second.reused).toBe(true);
    expect(third.reused).toBe(true);
  });

  it("treats different requests as different keys (distinct jobs stay distinct)", async () => {
    const store = new IdempotencyStore(dir);
    const seen: string[] = [];
    const submit = async (r: AgnesSubmitRequest) => {
      seen.push(r.jobRef ?? "");
      return { providerJobId: `vid_${seen.length}` };
    };
    await withSubmitIdempotency(store, request({ jobRef: "shot-05:keyframe-a" }), submit, { sleep: immediateSleep });
    await withSubmitIdempotency(store, request({ jobRef: "shot-06:keyframe-b" }), submit, { sleep: immediateSleep });
    expect(seen).toEqual(["shot-05:keyframe-a", "shot-06:keyframe-b"]);
  });

  it("serializes concurrent same-key submits to exactly one submission", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    const submit = async () => {
      submits += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { providerJobId: `vid_${submits}` };
    };
    const [a, b, c] = await Promise.all([
      withSubmitIdempotency(store, request(), submit, { sleep: immediateSleep }),
      withSubmitIdempotency(store, request(), submit, { sleep: immediateSleep }),
      withSubmitIdempotency(store, request(), submit, { sleep: immediateSleep }),
    ]);
    expect(submits).toBe(1);
    expect(a.providerJobId).toBe("vid_1");
    expect(b.providerJobId).toBe("vid_1");
    expect(c.providerJobId).toBe("vid_1");
    expect(a.reused || b.reused || c.reused).toBe(true);
  });

  it("retries transient failures with bounded backoff and persists the retry count", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    const outcome = await withSubmitIdempotency(
      store,
      request(),
      async () => {
        submits += 1;
        if (submits < 3) throw new AgnesRetryableHttpError(503, "try again");
        return { providerJobId: "vid_after_retry" };
      },
      { baseDelayMs: 1, maxAttempts: 4, sleep: immediateSleep },
    );
    expect(submits).toBe(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.retryCount).toBe(2);
    // retry count persisted in the durable record (spec §18)
    const persistedRecord = await store.get<AgnesSubmitRecord>(outcome.key);
    const persisted = persistedRecord?.result as AgnesSubmitRecord | undefined;
    expect(persisted?.retryCount).toBe(2);
    expect(persisted?.providerJobId).toBe("vid_after_retry");
    expect(persistedRecord?.result).not.toBeNull();
  });

  it("persists the retry count when the budget is exhausted", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    await expect(
      withSubmitIdempotency(
        store,
        request(),
        async () => {
          submits += 1;
          throw new AgnesRetryableHttpError(429, "always");
        },
        { baseDelayMs: 1, maxAttempts: 3, sleep: immediateSleep },
      ),
    ).rejects.toBeInstanceOf(AgnesSubmitFailedError);
    expect(submits).toBe(3);
    // A fresh store on the same dir (restart) still sees the persisted count.
    const restarted = new IdempotencyStore(dir);
    const keys = await readdir(dir);
    expect(keys.some((k) => k.endsWith(".json"))).toBe(true);
    // The failure must NOT be treated as success on a later call: the record
    // stays reserved, so a later call retries from the persisted count.
    let secondRound = 0;
    const outcome2 = await withSubmitIdempotency(
      restarted,
      request(),
      async () => {
        secondRound += 1;
        return { providerJobId: `vid_recovered_${secondRound}` };
      },
      { sleep: immediateSleep },
    );
    expect(secondRound).toBe(1);
    expect(outcome2.reused).toBe(false);
    expect(outcome2.retryCount).toBe(2); // carried over from the failed round
  });

  it("never submits when a providerJobId is already known (resume path)", async () => {
    const store = new IdempotencyStore(dir);
    let submits = 0;
    const outcome = await withSubmitIdempotency(
      store,
      request({ providerJobId: "vid_existing" }),
      async () => {
        submits += 1;
        return { providerJobId: "vid_SHOULD_NOT_APPEAR" };
      },
      { sleep: immediateSleep },
    );
    expect(submits).toBe(0);
    expect(outcome.providerJobId).toBe("vid_existing");
    expect(outcome.reused).toBe(true);
  });

  it("survives a crash mid-submit: reservation on disk, restart re-derives the same key", async () => {
    const shared = await mkdtemp(join(tmpdir(), "agn-010-crash-"));
    try {
      const store1 = new IdempotencyStore(shared);
      await withSubmitIdempotency(
        store1,
        request(),
        async () => {
          // Simulated crash: submit "in flight" at Agnes, process dies before
          // the completed record lands. The reservation must be durable.
          throw new Error("simulated crash before recording");
        },
        { sleep: immediateSleep },
      ).catch(() => undefined);

      // Restart with a fresh store over the same dir.
      const store2 = new IdempotencyStore(shared);
      let submits2 = 0;
      const outcome = await withSubmitIdempotency(
        store2,
        request(),
        async () => {
          submits2 += 1;
          return { providerJobId: "vid_after_restart" };
        },
        { sleep: immediateSleep },
      );
      // The reservation survived; the retry completes exactly once.
      expect(submits2).toBe(1);
      expect(outcome.providerJobId).toBe("vid_after_restart");
      expect(outcome.record.state).toBe("completed");
    } finally {
      await rm(shared, { recursive: true, force: true });
    }
  });

  it("rejects invalid requests before touching the store", async () => {
    const store = new IdempotencyStore(dir);
    await expect(
      withSubmitIdempotency(store, request({ model: "" }), async () => ({ providerJobId: "x" })),
    ).rejects.toBeInstanceOf(AgnesSubmitIdempotencyError);
    await expect(
      withSubmitIdempotency(
        store,
        request({ prompt: 42 as unknown as string }),
        async () => ({ providerJobId: "x" }),
      ),
    ).rejects.toBeInstanceOf(AgnesSubmitIdempotencyError);
  });

  it("validates the minimum request shape", () => {
    expect(() => validateAgnesSubmitRequest(request())).not.toThrow();
    expect(() =>
      validateAgnesSubmitRequest({ model: "agnes-video-2.5-flash", prompt: "x" }),
    ).not.toThrow();
    expect(() => validateAgnesSubmitRequest(undefined as unknown as AgnesSubmitRequest)).toThrow(
      AgnesSubmitIdempotencyError,
    );
    expect(() => validateAgnesSubmitRequest({ prompt: "no model" } as AgnesSubmitRequest)).toThrow(
      AgnesSubmitIdempotencyError,
    );
    expect(() =>
      validateAgnesSubmitRequest(request({ jobRef: 9 as unknown as string })),
    ).toThrow(AgnesSubmitIdempotencyError);
  });

  it("derives identical keys for the same logical request regardless of key order", () => {
    const full = request();
    const same = agnesSubmitKey("agnes-submit", {
      model: "agnes-video-2.5-flash",
      seconds: "5",
      aspect_ratio: "16:9",
      jobRef: "shot-05:keyframe-a",
      prompt: "a detective walks through neon rain",
      size: "720P",
    });
    const sameAgain = agnesSubmitKey("agnes-submit", {
      size: "720P",
      prompt: "a detective walks through neon rain",
      jobRef: "shot-05:keyframe-a",
      aspect_ratio: "16:9",
      seconds: "5",
      model: "agnes-video-2.5-flash",
    });
    expect(same).toBe(sameAgain);
    expect(same).toBe(agnesSubmitKey("agnes-submit", full));
    // a different scope → different key
    expect(agnesSubmitKey("agnes-submit", full)).not.toBe(
      agnesSubmitKey("agnes-image-submit", full),
    );
  });

  it("writes durable JSON records with no secret material", async () => {
    const store = new IdempotencyStore(dir);
    const outcome = await withSubmitIdempotency(
      store,
      request(),
      async () => ({ providerJobId: "vid_1" }),
      { sleep: immediateSleep },
    );
    const raw = await readFile(`${dir}/${outcome.key}.json`, "utf8");
    const parsed = JSON.parse(raw) as IdempotencyRecord<AgnesSubmitRecord>;
    expect(parsed.result?.state).toBe("completed");
    expect(parsed.result?.providerJobId).toBe("vid_1");
    expect(raw).not.toMatch(/sk-|bearer|authorization|api[_-]?key/i);
    // no temp litter
    const entries = await readdir(dir);
    expect(entries.every((e) => e.endsWith(".json"))).toBe(true);
  });
});

describe("record cleanup", () => {
  it("sweeps temp-file litter after a simulated crash", async () => {
    const store = new IdempotencyStore(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/orphan.tmp`, "litter", "utf8");
    const removed = await store.sweepTempFiles();
    expect(removed).toBe(1);
  });
});