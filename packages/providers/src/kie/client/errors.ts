/** Error taxonomy for the Kie client. Messages are safe to log by construction. */

/**
 * Which failure class an attempt fell into — drives the retry decision.
 * `retryable` errors are transient (network, timeout, 5xx, 429 with Retry-After).
 */
export type KieErrorKind =
  | "network" // connection refused/DNS reset/fetch threw a non-HTTP error
  | "timeout" // per-attempt deadline exceeded
  | "rate-limited" // HTTP 429
  | "server-error" // HTTP 5xx
  | "http-error" // any other non-2xx HTTP status
  | "bad-response"; // 2xx but body is not the documented envelope

/**
 * A Kie API failure. `message` never embeds the API key, the Authorization
 * header, or a raw response body (response bodies may echo request params).
 */
export class KieApiError extends Error {
  readonly kind: KieErrorKind;
  /** HTTP status when the failure is HTTP-shaped; undefined for network/timeout. */
  readonly status?: number;
  /**
   * Server-supplied code from the JSON envelope (`{code,msg,data}`) when the
   * body parsed as JSON; undefined otherwise. Never contains secrets.
   */
  readonly apiCode?: number;
  /** Server-supplied short message from the envelope; redacted of anything secret-shaped. */
  readonly apiMsg?: string;
  /** Server-supplied Retry-After header (seconds), when present on 429. */
  readonly retryAfterSec?: number;
  /** 1-based attempt number that produced this error. */
  readonly attempt: number;

  constructor(args: {
    kind: KieErrorKind;
    message: string;
    status?: number;
    apiCode?: number;
    apiMsg?: string;
    retryAfterSec?: number;
    attempt: number;
  }) {
    super(args.message);
    this.name = "KieApiError";
    this.kind = args.kind;
    this.status = args.status;
    this.apiCode = args.apiCode;
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
  // Remove long opaque token-looking runs.
  out = out.replace(/(?=[^\s"]*\d)(?=[^\s"]*[a-z])[^\s"]{20,}/gi, "[redacted]");
  return out;
}

/** True when an error of this shape is worth retrying. */
export function isRetryableError(kind: KieErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate-limited" || kind === "server-error";
}