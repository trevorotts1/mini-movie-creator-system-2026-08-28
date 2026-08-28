/**
 * KIE-009 — secret redaction layer.
 *
 * Every string that survives normalization (messages, detail values, log
 * lines) passes through {@link redactSecrets}. This is the single choke point
 * that guarantees the module's security invariant: an API key, Authorization
 * header, or credential-shaped token never reaches a log line, even when the
 * provider echoes request material back in an error message or when a caller
 * accidentally embeds their own config into the payload they hand us.
 */

/** Redaction marker used everywhere in this module. */
export const REDACTED = "[redacted]";

/**
 * Patterns that mark content as credential-shaped. Order matters: scheme
 * prefixes first (so the whole credential run is consumed), then bare
 * long opaque tokens.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Authorization scheme + credential: "Bearer sk-...", "Basic dXNlcjpwYXNz".
  /(?:bearer|basic|token)\s+[^\s"',;]+/gi,
  // Query-string credentials: ?apiKey=...&api_key=...&access_token=...
  /(?:apiKey|api_key|apikey|access_token|refresh_token|apiToken|api_token|authorization)=(?:[^&\s"']+)/gi,
  // Long opaque token-looking runs (mixed letters+digits, 20+ chars, no spaces).
  // Deliberately aggressive: over-redaction is free, under-redaction leaks.
  /(?=[^\s"']*\d)(?=[^\s"']*[a-zA-Z])[^\s"']{20,}/g,
  // PEM key bodies.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** True when a value looks like it carries a credential. */
export function looksSecretLike(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value));
}

/**
 * Strip credential-shaped content from a string. Returns the input unchanged
 * when nothing secret-shaped is present (checked via a non-global probe so
 * repeated calls are cheap and stateless).
 */
export function redactSecrets(value: string): string {
  if (!looksSecretLike(value)) return value;
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-copy a JSON-like value with every string redacted. Non-JSON values
 * (functions, symbols, circular structures) are replaced with a type tag so
 * the result is always safely serializable. Depth-capped: provider payloads
 * are shallow; anything deeper is not worth the CPU.
 */
export function redactDeep<T>(value: T, maxDepth = 6): unknown {
  return redactValue(value, 0, maxDepth, new WeakSet());
}

function redactValue(value: unknown, depth: number, maxDepth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string") return redactSecrets(value as string);
  if (type === "number" || type === "boolean" || type === "bigint") return value;
  if (depth >= maxDepth) return `[max-depth:${type}]`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.slice(0, 100).map((entry) => redactValue(entry, depth + 1, maxDepth, seen));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
    };
  }
  if (type === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj).slice(0, 100)) {
      out[key] = redactValue(entry, depth + 1, maxDepth, seen);
    }
    return out;
  }
  // function, symbol, etc. — never serialize behavior.
  return `[${type}]`;
}

/**
 * Build one redacted, single-line log string for a normalized failure.
 * Guaranteed secret-free: it is composed only from already-redacted fields.
 */
export function failureToLogLine(failure: {
  classification: string;
  code: string;
  message: string;
  status?: number;
  attempt?: number;
}): string {
  const parts = [
    `kie-failure class=${failure.classification}`,
    `code=${failure.code}`,
    failure.status !== undefined ? `status=${failure.status}` : undefined,
    failure.attempt !== undefined ? `attempt=${failure.attempt}` : undefined,
    `msg="${failure.message.replace(/\s+/g, " ").trim()}"`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}