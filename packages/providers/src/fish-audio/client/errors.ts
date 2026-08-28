/// <reference types="node" />
/**
 * Error taxonomy for the Fish Audio client. Messages are safe to log by
 * construction: they never embed the API key, the Authorization header, or a
 * raw response body (bodies may echo request text).
 */

/**
 * Which failure class an attempt fell into — drives the retry decision.
 * `retryable` errors are transient (network, timeout, 429, 5xx).
 * Fish documents 401 (no permission), 402 (no payment / out of credits),
 * 503 (overloaded) on the TTS endpoint — 401/402 are terminal, 503 retries.
 */
export type FishErrorKind =
  | "network" // connection refused/DNS/fetch threw a non-HTTP error
  | "timeout" // per-attempt deadline exceeded
  | "rate-limited" // HTTP 429
  | "server-error" // HTTP 5xx
  | "http-error" // any other non-2xx HTTP status (401/402/404/…)
  | "bad-response"; // 2xx but body is not what the API documents

/**
 * A Fish Audio API failure. `message` never contains the API key or the
 * Authorization header; server-supplied text is scrubbed before attachment.
 */
export class FishApiError extends Error {
  readonly kind: FishErrorKind;
  /** HTTP status when the failure is HTTP-shaped; undefined for network/timeout. */
  readonly status?: number;
  /** Server-supplied `message` from the JSON error body; scrubbed of secrets. */
  readonly apiMsg?: string;
  /** Server-supplied `status` field from the JSON error body, when numeric. */
  readonly apiStatus?: number;
  /** Server-supplied Retry-After header (seconds), when present on 429. */
  readonly retryAfterSec?: number;
  /** 1-based attempt number that produced this error. */
  readonly attempt: number;

  constructor(args: {
    kind: FishErrorKind;
    message: string;
    status?: number;
    apiMsg?: string;
    apiStatus?: number;
    retryAfterSec?: number;
    attempt: number;
  }) {
    super(args.message);
    this.name = "FishApiError";
    this.kind = args.kind;
    this.status = args.status;
    this.apiMsg = sanitizeMsg(args.apiMsg);
    this.apiStatus = args.apiStatus;
    this.retryAfterSec = args.retryAfterSec;
    this.attempt = args.attempt;
  }
}

/**
 * Strip credential-shaped content out of any server-provided message before it
 * is attached to an error (belt-and-braces: server msgs are echoed text).
 */
function sanitizeMsg(msg: string | undefined): string | undefined {
  if (msg === undefined) return undefined;
  let out = msg;
  // Remove bearer/basic schemes outright.
  out = out.replace(/(?:bearer|basic)\s+[^\s"']+/gi, "[redacted]");
  // Remove long opaque token-looking runs.
  out = out.replace(/(?=[^\s"]*\d)(?=[^\s"]*[a-z])[^\s"]{20,}/gi, "[redacted]");
  return out;
}

/** True when an error of this shape is worth retrying. */
export function isRetryableError(kind: FishErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate-limited" || kind === "server-error";
}