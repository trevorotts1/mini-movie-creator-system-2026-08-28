/**
 * KIE-009 — classify one Kie HTTP response shape (status + parsed body) into
 * the unified taxonomy. Pure function; no I/O. Callers that already parsed a
 * JSON envelope prefer this over {@link normalizeUnknownFailure}.
 */
import type { NormalizedKieFailure } from "./taxonomy.js";
import { redactDeep, redactSecrets } from "./redact.js";

/** Body of a Kie response as (best-effort) parsed JSON, or undefined. */
export type KieHttpBody = unknown;

/**
 * HTTP status + optional parsed body → taxonomy entry.
 *
 * Mapping:
 * - 401/403 → fatal `auth` (key invalid/forbidden; retrying unchanged fails).
 * - 402     → quota `payment_required` (account balance exhausted).
 * - 404/405 → fatal `not_found` (bad endpoint/model; code fix needed).
 * - 408     → retryable `timeout`.
 * - 409     → fatal `conflict` (state clash; blind retry amplifies it).
 * - 413/422 → fatal `invalid_request` (payload rejected; same bytes fail same way).
 * - 429     → quota `rate_limited` (pacing; honor Retry-After).
 * - 5xx     → retryable `server_error` (provider-side transient).
 * - other   → fatal `http_error` (conservative default; never loop on unknown).
 */
export function classifyKieHttpFailure(
  status: number,
  body?: KieHttpBody,
  opts: { attempt?: number } = {},
): NormalizedKieFailure {
  const envelope = readEnvelope(body);
  const serverMsg = envelope?.msg !== undefined ? redactSecrets(String(envelope.msg)) : undefined;
  const base = {
    status,
    attempt: opts.attempt,
    detail: body === undefined ? undefined : { body: redactDeep(body) },
  };

  if (status === 401 || status === 403) {
    return {
      classification: "fatal",
      retryable: false,
      code: "kie:auth",
      message: serverMsg ? `Kie auth rejected (${status}): ${serverMsg}` : `Kie auth rejected (HTTP ${status})`,
      source: "http",
      ...base,
    };
  }
  if (status === 402) {
    return {
      classification: "quota",
      retryable: false,
      code: "kie:payment_required",
      message: "Kie account balance exhausted (HTTP 402); top up before retrying",
      source: "http",
      ...base,
    };
  }
  if (status === 404 || status === 405) {
    return {
      classification: "fatal",
      retryable: false,
      code: "kie:not_found",
      message: `Kie endpoint not found (HTTP ${status}); check model slug and base URL`,
      source: "http",
      ...base,
    };
  }
  if (status === 408) {
    return {
      classification: "retryable",
      retryable: true,
      code: "kie:timeout",
      message: "Kie request timed out (HTTP 408)",
      source: "http",
      ...base,
    };
  }
  if (status === 409) {
    return {
      classification: "fatal",
      retryable: false,
      code: "kie:conflict",
      message: serverMsg ? `Kie request conflict (HTTP 409): ${serverMsg}` : "Kie request conflict (HTTP 409)",
      source: "http",
      ...base,
    };
  }
  if (status === 413 || status === 422) {
    return {
      classification: "fatal",
      retryable: false,
      code: "kie:invalid_request",
      message: serverMsg
        ? `Kie rejected the request payload (HTTP ${status}): ${serverMsg}`
        : `Kie rejected the request payload (HTTP ${status})`,
      source: "http",
      ...base,
    };
  }
  if (status === 429) {
    return {
      classification: "quota",
      // Soft quota: pacing, not exhaustion — retry after Retry-After is fine.
      retryable: true,
      code: "kie:rate_limited",
      message: "Kie rate limit hit (HTTP 429); back off and retry",
      retryAfterSec: readRetryAfterSeconds(body),
      source: "http",
      ...base,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      classification: "retryable",
      retryable: true,
      code: "kie:server_error",
      message: `Kie server error (HTTP ${status})`,
      source: "http",
      ...base,
    };
  }
  return {
    classification: "fatal",
    retryable: false,
    code: "kie:http_error",
    message: `Kie returned unexpected HTTP status ${status}`,
    source: "http",
    ...base,
  };
}

/** Read the documented `{code,msg,data}` envelope fields off a parsed body. */
function readEnvelope(body: KieHttpBody): { code?: number; msg?: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const out: { code?: number; msg?: string } = {};
  if (typeof record["msg"] === "string") out.msg = record["msg"];
  if (typeof record["code"] === "number") out.code = record["code"];
  return out;
}

/** Extract Retry-After seconds from a 429 body when the server put it there. */
function readRetryAfterSeconds(body: KieHttpBody): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const candidates = [body, (body as Record<string, unknown>)["data"], (body as Record<string, unknown>)["error"]];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = (candidate as Record<string, unknown>)["retryAfter"] ?? (candidate as Record<string, unknown>)["retry_after"];
    const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return undefined;
}