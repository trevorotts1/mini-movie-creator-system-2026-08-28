/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  KieNormalizedError,
  classifyKieHttpFailure,
  classifyKieTaskFailure,
  failureToLogLine,
  isQuotaShapedTaskFailure,
  looksSecretLike,
  normalizeKieFailure,
  normalizeKieFailureToError,
  redactDeep,
  redactSecrets,
} from "./index.js";

/** A secret-shaped token used ONLY to prove redaction. Not a real credential. */
const FAKE_KEY = "sk-kie-test-0123456789abcdef0123456789";

/** Duck-typed KIE-001 KieApiError stand-in (same field shape, own class). */
class FakeKieApiError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly status?: number,
    readonly apiCode?: number,
    readonly apiMsg?: string,
    readonly retryAfterSec?: number,
    readonly attempt?: number,
  ) {
    super(message);
    this.name = "KieApiError";
  }
}

describe("taxonomy normalization — HTTP shapes", () => {
  it("classifies 429 as quota/retryable with Retry-After from body", () => {
    const f = classifyKieHttpFailure(429, { code: 429, msg: "slow down", data: { retryAfter: 30 } }, { attempt: 2 });
    expect(f.classification).toBe("quota");
    expect(f.retryable).toBe(true);
    expect(f.retryAfterSec).toBe(30);
    expect(f.status).toBe(429);
    expect(f.attempt).toBe(2);
  });

  it("classifies 401/403 as fatal auth", () => {
    for (const status of [401, 403]) {
      const f = classifyKieHttpFailure(status, { msg: "invalid api key" });
      expect(f.classification).toBe("fatal");
      expect(f.retryable).toBe(false);
      expect(f.code).toBe("kie:auth");
      expect(f.status).toBe(status);
    }
  });

  it("classifies 402 as quota payment_required", () => {
    const f = classifyKieHttpFailure(402);
    expect(f.classification).toBe("quota");
    expect(f.retryable).toBe(false);
    expect(f.code).toBe("kie:payment_required");
  });

  it("classifies 5xx as retryable server error", () => {
    for (const status of [500, 502, 503, 504]) {
      const f = classifyKieHttpFailure(status);
      expect(f.classification).toBe("retryable");
      expect(f.retryable).toBe(true);
      expect(f.code).toBe("kie:server_error");
    }
  });

  it("classifies 413/422/404/405/409 as fatal", () => {
    for (const status of [404, 405, 409, 413, 422]) {
      const f = classifyKieHttpFailure(status, { msg: "bad input" });
      expect(f.classification).toBe("fatal");
      expect(f.retryable).toBe(false);
    }
  });

  it("classifies unknown status conservatively as fatal", () => {
    const f = classifyKieHttpFailure(418);
    expect(f.classification).toBe("fatal");
    expect(f.retryable).toBe(false);
    expect(f.code).toBe("kie:http_error");
  });

  it("caps an absurd server-supplied Retry-After (unbounded-sleep guard)", () => {
    const huge = classifyKieHttpFailure(429, { retryAfter: 86400 });
    expect(huge.retryAfterSec).toBe(900);
    const sane = classifyKieHttpFailure(429, { retryAfter: 30 });
    expect(sane.retryAfterSec).toBe(30);
  });

  it("keeps the server envelope message redacted", () => {
    const f = classifyKieHttpFailure(422, { msg: `bad payload, key ${FAKE_KEY}` });
    expect(f.message).not.toContain(FAKE_KEY);
  });
});

describe("taxonomy normalization — task failure payloads", () => {
  it("normalizes a failed task into fatal task_failed", () => {
    const f = classifyKieTaskFailure({ state: "fail", failMsg: "generation failed", failCode: 5001 });
    expect(f.classification).toBe("fatal");
    expect(f.retryable).toBe(false);
    expect(f.code).toBe("kie:task_failed");
    expect(f.source).toBe("task");
    expect(f.message).toContain("generation failed");
    expect(f.detail?.failCode).toBe(5001);
  });

  it("detects quota-shaped task failure messages", () => {
    expect(isQuotaShapedTaskFailure({ state: "fail", failMsg: "insufficient balance, please top up" })).toBe(true);
    expect(isQuotaShapedTaskFailure({ state: "fail", failMsg: "quota exceeded for model" })).toBe(true);
    expect(isQuotaShapedTaskFailure({ state: "fail", failMsg: "prompt rejected: unsafe content" })).toBe(false);
  });

  it("folds quota-shaped task failures into the quota class", () => {
    const f = classifyKieTaskFailure({ state: "failed", failMsg: "account balance is insufficient" });
    expect(f.classification).toBe("quota");
    expect(f.retryable).toBe(false);
    expect(f.code).toBe("kie:task_quota");
  });

  it("never throws on a garbage task payload", () => {
    const f = classifyKieTaskFailure({ state: "fail" });
    expect(f.classification).toBe("fatal");
    expect(f.message).toContain("without a failure message");
  });
});

describe("normalizeKieFailure — every shape folds to the taxonomy", () => {
  it("passes through an already-normalized failure untouched", () => {
    const first = classifyKieHttpFailure(500);
    expect(normalizeKieFailure(first)).toBe(first);
  });

  it("maps KieApiError-like rate-limited to quota", () => {
    const f = normalizeKieFailure(new FakeKieApiError("rate-limited", "Kie rate limit hit (HTTP 429)", 429, undefined, undefined, 12, 1));
    expect(f.classification).toBe("quota");
    expect(f.retryable).toBe(true);
    expect(f.retryAfterSec).toBe(12);
  });

  it("maps KieApiError-like server-error and network to retryable", () => {
    expect(normalizeKieFailure(new FakeKieApiError("server-error", "boom", 502)).retryable).toBe(true);
    expect(normalizeKieFailure(new FakeKieApiError("network", "fetch failed")).retryable).toBe(true);
    expect(normalizeKieFailure(new FakeKieApiError("timeout", "request timed out")).classification).toBe("retryable");
  });

  it("maps KieApiError-like http-error by status and bad-response to fatal", () => {
    const byStatus = normalizeKieFailure(new FakeKieApiError("http-error", "Kie auth rejected (HTTP 401)", 401));
    expect(byStatus.code).toBe("kie:auth");
    expect(byStatus.classification).toBe("fatal");
    const bad = normalizeKieFailure(new FakeKieApiError("bad-response", "2xx body not the documented envelope"));
    expect(bad.classification).toBe("fatal");
    expect(bad.code).toBe("kie:bad_response");
  });

  it("carries KieApiError Retry-After across the http-error mapping", () => {
    const f = normalizeKieFailure(new FakeKieApiError("http-error", "rate limit hit", 429, undefined, undefined, 12, 1));
    expect(f.classification).toBe("quota");
    expect(f.retryAfterSec).toBe(12);
  });

  it("maps a raw task failure payload thrown as a value", () => {
    const f = normalizeKieFailure({ state: "fail", failMsg: "model refused the prompt" });
    expect(f.code).toBe("kie:task_failed");
    expect(f.source).toBe("task");
  });

  it("maps AbortError/timeout Errors to retryable transport", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const f = normalizeKieFailure(err);
    expect(f.classification).toBe("retryable");
    expect(f.retryable).toBe(true);
    expect(f.code).toBe("kie:timeout");
    expect(f.source).toBe("transport");
  });

  it("maps connection-refused style Errors to retryable network", () => {
    const f = normalizeKieFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    expect(f.retryable).toBe(true);
    expect(f.code).toBe("kie:network");
  });

  it("maps an ordinary Error to fatal", () => {
    const f = normalizeKieFailure(new Error("something else entirely"));
    expect(f.classification).toBe("fatal");
    expect(f.retryable).toBe(false);
    expect(f.code).toBe("kie:other");
  });

  it("normalizes a thrown string", () => {
    const f = normalizeKieFailure("weird upstream state");
    expect(f.classification).toBe("fatal");
    expect(f.source).toBe("unknown");
    expect(f.message).toContain("weird upstream state");
  });

  it("maps undefined/null throws without throwing", () => {
    expect(normalizeKieFailure(undefined).code).toBe("kie:unknown_failure");
    expect(normalizeKieFailure(null).code).toBe("kie:unknown_failure");
  });

  it("maps an Error with a numeric status through the HTTP classifier", () => {
    const err = Object.assign(new Error("HTTP 502 from upstream"), { status: 502 });
    const f = normalizeKieFailure(err);
    expect(f.classification).toBe("retryable");
    expect(f.status).toBe(502);
  });

  it("normalizes to a KieNormalizedError when asked", () => {
    const err = normalizeKieFailureToError({ state: "fail", failMsg: "nope" });
    expect(err).toBeInstanceOf(KieNormalizedError);
    expect(err.failure.code).toBe("kie:task_failed");
    expect(err.message).toContain("nope");
  });
});

describe("secret redaction — no leakage into messages, detail, or log lines", () => {
  it("redacts bearer tokens and long opaque tokens from strings", () => {
    const out = redactSecrets(`Authorization: Bearer ${FAKE_KEY} failed`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("[redacted]");
  });

  it("detects secret-like strings", () => {
    expect(looksSecretLike(`token ${FAKE_KEY}`)).toBe(true);
    expect(looksSecretLike("plain failure message")).toBe(false);
  });

  it("redacts deep payloads including nested keys", () => {
    const out = redactDeep({
      apiKey: FAKE_KEY,
      nested: { Authorization: `Bearer ${FAKE_KEY}`, ok: "safe" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    const nested = out["nested"] as Record<string, unknown>;
    expect(nested["ok"]).toBe("safe");
  });

  it("redacts Error instances to name+redacted message", () => {
    const out = redactDeep(new Error(`failed with key ${FAKE_KEY}`)) as { name: string; message: string };
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain(FAKE_KEY);
  });

  it("redacts a server echo of the API key inside failMsg", () => {
    const f = classifyKieTaskFailure({ state: "fail", failMsg: `invalid key ${FAKE_KEY}` });
    expect(f.message).not.toContain(FAKE_KEY);
  });

  it("redacts a thrown string containing a key", () => {
    const f = normalizeKieFailure(`request rejected, key ${FAKE_KEY}`);
    expect(f.message).not.toContain(FAKE_KEY);
  });

  it("failureToLogLine contains no secret even when the message had one", () => {
    const f = normalizeKieFailure(new FakeKieApiError("http-error", `rejected key ${FAKE_KEY}`, 401));
    const line = failureToLogLine(f);
    expect(line).not.toContain(FAKE_KEY);
    expect(line).toContain("kie-failure");
  });

  it("failureToLogLine redacts a raw, never-normalized message (defense in depth)", () => {
    const raw = {
      classification: "fatal",
      code: "kie:leak_sim",
      message: `upstream echoed Bearer ${FAKE_KEY}`,
    };
    const line = failureToLogLine(raw);
    expect(line).not.toContain(FAKE_KEY);
    expect(line).toContain("[redacted]");
  });

  it("redacts query-string credential parameters", () => {
    const out = redactSecrets("GET https://api.kie.test/v1?apiKey=abcdef123456789abcdef123456789 returned 500");
    expect(out).not.toContain("abcdef123456789abcdef123456789");
  });
});