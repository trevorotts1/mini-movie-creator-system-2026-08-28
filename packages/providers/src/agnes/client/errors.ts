/** Error taxonomy for the Agnes client. Messages are safe to log by construction. */

/**
 * Which failure class an attempt fell into — drives the retry decision.
 * `retryable` errors are transient (network, timeout, 5xx, 429 with Retry-After).
 * Agnes docs (wiki.agnes-ai.com/en/docs/agnes-video-25, verified 2026-08-28)
 * confirm 400/401/403/404 are terminal and 429/500 are retryable.
 */
export type AgnesErrorKind =
  | "network" // connection refused/DNS reset/fetch threw a non-HTTP error
  | "timeout" // per-attempt deadline exceeded
  | "rate-limited" // HTTP 429
  | "server-error" // HTTP 5xx
  | "http-error" // any other non-2xx HTTP status (400/401/403/404 ...)
  | "bad-response"; // 2xx but body is not a parseable task object

/**
 * An Agnes API failure. `message` never embeds the API key, the Authorization
 * header, or a raw response body (response bodies may echo request params).
 */
export class AgnesApiError extends Error {
  readonly kind: AgnesErrorKind;
  /** HTTP status when the failure is HTTP-shaped; undefined for network/timeout. */
  readonly status?: number;
  /** Server-supplied error message field, redacted of anything secret-shaped. */
  readonly apiMsg?: string;
  /** Server-supplied Retry-After header (seconds), when present on 429. */
  readonly retryAfterSec?: number;
  /** 1-based attempt number that produced this error. */
  readonly attempt: number;

  constructor(args: {
    kind: AgnesErrorKind;
    message: string;
    status?: number;
    apiMsg?: string;
    retryAfterSec?: number;
    attempt: number;
  }) {
    super(args.message);
    this.name = "AgnesApiError";
    this.kind = args.kind;
    this.status = args.status;
    this.apiMsg = sanitizeMsg(args.apiMsg);
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
  // Secret-looking VALUES that follow credential phrases, even when the token
  // is too short for the opaque-token pattern below. A value qualifies when
  // it is token-shaped (contains a digit or a -_. separator); the phrase
  // itself stays (the words "API key" are not a secret — its value is).
  out = out.replace(
    /((?:api[ _-]?key|apikey|auth(?:entication)?[ _-]?(?:token|header|key)|secret|password|credential)s?\s*(?:=|:)?\s*(?:is|was|invalid|incorrect|wrong|expired|revoked)?\s*)(?=[^\s"']*(?:\d|[-_.]))([^\s"']{4,})/gi,
    "$1[redacted]",
  );
  // Remove long opaque token-looking runs (mixes digits + letters; this also
  // covers full URLs the server may echo — safe direction: redact).
  out = out.replace(/(?=[^\s"]*\d)(?=[^\s"]*[a-z])[^\s"]{16,}/gi, "[redacted]");
  return out;
}

/** True when an error of this shape is worth retrying. */
export function isRetryableError(kind: AgnesErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate-limited" || kind === "server-error";
}

/** True when an HTTP status of this shape is worth retrying (5xx or 429). */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}
