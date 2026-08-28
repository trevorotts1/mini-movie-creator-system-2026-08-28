/// <reference types="node" />
import { createHash } from "node:crypto";

/**
 * Canonical JSON: keys sorted recursively so structurally identical requests
 * hash identically regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * Stable sha-256 request hash over {scope, canonical(request)}.
 * Two submissions with the same scope + request params produce the same key.
 */
export function requestHash(
  scope: string,
  request: unknown,
  opts?: { length?: number },
): string {
  const full = createHash("sha256")
    .update(canonicalize({ scope, request }))
    .digest("hex");
  const length = opts?.length ?? 64;
  return full.slice(0, Math.min(length, full.length));
}