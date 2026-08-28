import type { LogContext, RedactionHook } from "./types.js";

/** Value written in place of anything that looks like a secret. */
export const REDACTED = "[REDACTED]";

/**
 * Key names whose values are always redacted, regardless of value shape.
 * Keys are split into lowercase word tokens on separators (snake/kebab/dots)
 * AND camelCase boundaries, then checked against the sensitive-word set —
 * so `apiKey`, `Api_Key`, `mySecretValue`, and `GHL_ACCESS_TOKEN` all match,
 * while `monkey`, `authority`, or `keyboard` do not.
 */
const SENSITIVE_KEY_WORDS: ReadonlySet<string> = new Set([
  "api",
  "apikey",
  "key",
  "token",
  "access",
  "secret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "bearer",
  "private",
  "client",
  "session",
  "refresh",
]);

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((word) => SENSITIVE_KEY_WORDS.has(word));
}

/**
 * Value shapes that look like credentials even under an innocuous key:
 * long opaque alphanumerics (>= 20 chars mixing letters+digits, no spaces),
 * provider-style prefixed keys (sk-..., ghp_..., pat-...), and
 * scheme-bearing credentials (basic/bearer/authorization headers, query tokens).
 */
const OPAQUE_VALUE_PATTERN = /^(?:[a-z0-9_-]*\s*)?(?=[^\s]*\d)(?=[^\s]*[a-z])[^\s]{20,}$/i;
const PREFIXED_KEY_PATTERN =
  /^(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|ak|nk|pat|ntn|sk-ant|sbp|key|tok)[-_][^\s]{8,}$/i;
const CREDENTIAL_SCHEME_PATTERN = /^(?:bearer|basic|token)\s+\S+/i;

/**
 * Built-in redaction hook. Scrubs values whose KEY matches credential names
 * (api key, token, secret, password, authorization, …) and values whose SHAPE
 * matches a credential even under a harmless key. Deep: descends into nested
 * objects and arrays. Returns the original reference when nothing changed.
 */
export const redactSensitive: RedactionHook = (context) => {
  const result = scrubValue(context, undefined);
  return (result as LogContext) ?? context;
};

function scrubValue(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSensitiveKey(key)) {
    return value === undefined || value === null ? value : REDACTED;
  }
  if (typeof value === "string") {
    if (PREFIXED_KEY_PATTERN.test(value) || CREDENTIAL_SCHEME_PATTERN.test(value)) {
      return REDACTED;
    }
    if (OPAQUE_VALUE_PATTERN.test(value)) {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const scrubbed = scrubValue(item, undefined);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      const scrubbed = scrubValue(v, k);
      if (scrubbed !== v) changed = true;
      next[k] = scrubbed;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * Combines hooks left-to-right onto a context. The built-in
 * {@link redactSensitive} always runs LAST so pattern-based scrubbing survives
 * any domain hook reordering. Never mutates the input context.
 */
export function applyRedaction(
  context: LogContext,
  hooks: readonly RedactionHook[],
): LogContext {
  let result = context;
  for (const hook of hooks) {
    result = hook(result) ?? result;
  }
  return redactSensitive(result);
}