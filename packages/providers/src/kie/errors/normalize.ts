/**
 * KIE-009 — the single front door: normalize ANY thrown value or failure
 * shape into the unified taxonomy. This is the function every Kie call site
 * wraps its failures with.
 */
import type { NormalizedKieFailure } from "./taxonomy.js";
import { KieNormalizedError } from "./taxonomy.js";
import { classifyKieHttpFailure } from "./http.js";
import { classifyKieTaskFailure, type KieTaskFailurePayload } from "./task.js";
import { redactDeep, redactSecrets } from "./redact.js";

/**
 * Duck-typed shape of KIE-001's `KieApiError` (kind/status/apiCode/apiMsg).
 * Imported structurally, not by module path: this module must not depend on
 * merge order of sibling tasks.
 */
export interface KieApiErrorLike {
  name?: string;
  kind?: string;
  status?: number;
  apiCode?: number;
  apiMsg?: string;
  retryAfterSec?: number;
  attempt?: number;
  message: string;
}

/** Anything that can be thrown or caught. */
export type UnknownFailure = unknown;

/**
 * Normalize any failure into the taxonomy. Handles, in order:
 * 1. A value already carrying a {@link NormalizedKieFailure} (idempotent pass-through).
 * 2. KieApiError-like objects (KIE-001 transport errors) → mapped via kind/status.
 * 3. Error objects with a `status` number (fetch-style) → HTTP classification.
 * 4. Raw task-info failure payloads (state "fail"/"failed"/"error").
 * 5. Any other Error → redacted fatal.
 * 6. Anything else (string, undefined, garbage) → redacted fatal `unknown`.
 *
 * Never throws. Never returns a failure containing secret-shaped content.
 */
export function normalizeKieFailure(
  failure: UnknownFailure,
  opts: { attempt?: number } = {},
): NormalizedKieFailure {
  // 1. Already normalized — pass through untouched.
  if (isNormalizedFailure(failure)) return failure;

  // 2. KieApiError-like (KIE-001 client errors).
  if (isKieApiErrorLike(failure)) return fromKieApiErrorLike(failure, opts.attempt);

  // 3. Error carrying an HTTP status.
  if (failure instanceof Error && typeof (failure as { status?: unknown }).status === "number") {
    const carrier = failure as unknown as { status: number; body?: unknown };
    return classifyKieHttpFailure(carrier.status, carrier.body, { attempt: opts.attempt });
  }

  // 4. Raw task-info failure payload (state indicates failure).
  if (isTaskFailurePayload(failure)) return classifyKieTaskFailure(failure, { attempt: opts.attempt });

  // 5. Plain Error (transport throw, timeout, etc.).
  if (failure instanceof Error) {
    const kind = inferTransportKind(failure);
    return {
      classification: kind === "timeout" || kind === "network" ? "retryable" : "fatal",
      retryable: kind === "timeout" || kind === "network",
      code: `kie:${kind}`,
      message: redactSecrets(failure.message || failure.name || "Kie request failed"),
      source: "transport",
      attempt: opts.attempt,
      detail: { name: failure.name },
    };
  }

  // 6. Anything else.
  return {
    classification: "fatal",
    retryable: false,
    code: "kie:unknown_failure",
    message: redactSecrets(describeNonError(failure)),
    source: "unknown",
    attempt: opts.attempt,
    detail: { thrown: redactDeep(failure) },
  };
}

/** Normalize then wrap in a {@link KieNormalizedError} for throwing. */
export function normalizeKieFailureToError(failure: UnknownFailure, opts: { attempt?: number } = {}): KieNormalizedErrorLike {
  const normalized = normalizeKieFailure(failure, opts);
  return new KieNormalizedError(normalized);
}

/** Structural type so callers can wrap without importing the class. */
export interface KieNormalizedErrorLike extends Error {
  readonly failure: NormalizedKieFailure;
}

// Re-export so a call site can `new` it via this module alone.
export { KieNormalizedError };

// --- narrowing helpers -------------------------------------------------------

function isNormalizedFailure(value: unknown): value is NormalizedKieFailure {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record["classification"] === "retryable" || record["classification"] === "fatal" || record["classification"] === "quota") &&
    typeof record["retryable"] === "boolean" &&
    typeof record["code"] === "string" &&
    typeof record["message"] === "string" &&
    typeof record["source"] === "string"
  );
}

function isKieApiErrorLike(value: unknown): value is KieApiErrorLike {
  if (!(value instanceof Error)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") return false;
  // KIE-001 kinds: network | timeout | rate-limited | server-error | http-error | bad-response.
  return ["network", "timeout", "rate-limited", "server-error", "http-error", "bad-response"].includes(kind);
}

function fromKieApiErrorLike(error: KieApiErrorLike, attempt?: number): NormalizedKieFailure {
  const effectiveAttempt = error.attempt ?? attempt;
  if (error.kind === "rate-limited") {
    return {
      classification: "quota",
      retryable: true,
      code: "kie:rate_limited",
      message: redactSecrets(error.message),
      status: error.status,
      retryAfterSec: error.retryAfterSec,
      source: "http",
      attempt: effectiveAttempt,
    };
  }
  if (error.kind === "server-error") {
    return {
      classification: "retryable",
      retryable: true,
      code: "kie:server_error",
      message: redactSecrets(error.message),
      status: error.status,
      source: "http",
      attempt: effectiveAttempt,
    };
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return {
      classification: "retryable",
      retryable: true,
      code: `kie:${error.kind === "timeout" ? "timeout" : "network"}`,
      message: redactSecrets(error.message),
      source: "transport",
      attempt: effectiveAttempt,
    };
  }
  // http-error / bad-response: fatal by default — an unexpected status or a
  // malformed 2xx envelope is not fixed by retrying the same bytes.
  if (error.status !== undefined && error.kind === "http-error") {
    const classified = classifyKieHttpFailure(error.status, undefined, { attempt: effectiveAttempt });
    const apiMsg = error.apiMsg !== undefined ? redactSecrets(error.apiMsg) : undefined;
    // KIE-001 carries Retry-After on rate-limited errors; the HTTP classifier
    // never sees headers, so carry the field across instead of dropping it.
    const retryAfterSec = classified.retryAfterSec ?? error.retryAfterSec;
    return {
      ...classified,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      detail: { ...classified.detail, apiCode: error.apiCode, apiMsg },
    };
  }
  return {
    classification: "fatal",
    retryable: false,
    code: "kie:bad_response",
    message: redactSecrets(error.message),
    status: error.status,
    source: "http",
    attempt: effectiveAttempt,
    detail: { apiCode: error.apiCode, apiMsg: error.apiMsg !== undefined ? redactSecrets(error.apiMsg) : undefined },
  };
}

function isTaskFailurePayload(value: unknown): value is KieTaskFailurePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = (value as Record<string, unknown>)["state"];
  if (typeof state !== "string") return false;
  const normalized = state.trim().toLowerCase();
  return normalized === "fail" || normalized === "failed" || normalized === "error";
}

function inferTransportKind(error: Error): "timeout" | "network" | "other" {
  const name = error.name;
  const message = error.message.toLowerCase();
  if (name === "AbortError" || name === "TimeoutError" || /timeout|timed out|abort/.test(message)) return "timeout";
  if (/network|fetch failed|econnrefused|enotfound|econnreset|dns|socket|socket connection|connection refused|connection reset/.test(message)) {
    return "network";
  }
  return "other";
}

function describeNonError(value: unknown): string {
  if (value === undefined || value === null) return "Kie call failed with a thrown non-error value";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? `Kie call failed: ${trimmed}` : "Kie call failed with an empty error string";
  }
  return "Kie call failed with a thrown non-error value";
}