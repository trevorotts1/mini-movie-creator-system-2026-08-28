/// <reference types="node" />
/**
 * Cache-key derivation for the dialogue cache (FISH-005).
 *
 * The key is a SHA-256 over a CANONICAL serialization of the synthesis
 * request, so the same text+voice+model+parameters always produces the same
 * key regardless of property order or formatting — that is what makes the
 * cache idempotent. Any material change to the request (different text, voice,
 * model, or synthesis parameter) produces a different key and a fresh
 * synthesis; nothing else does.
 *
 * Dialogue text is untrusted content: it is only serialized into a JSON
 * document and hashed. It is never `eval`ed, never interpolated into code,
 * never used to construct paths.
 */
import { createHash } from "node:crypto";
import type { FishDialogueRequest } from "./types.js";

/** Key format version. Bump when the canonical serialization changes so old
 * entries age out instead of colliding. */
export const FISH_CACHE_KEY_VERSION = "fsh1";

/** Length prefix of the key shown in UIs/logs (full hash kept on disk). */
export const FISH_CACHE_KEY_DISPLAY_LEN = 16;

/**
 * Normalize a request into a stable, order-independent plain object.
 * Arrays keep order (voice order changes S2 dialogue); object keys are
 * emitted in a fixed field order; undefined fields are dropped. Numbers are
 * emitted as-is (JSON round-trip is stable for finite values).
 */
export function canonicalizeRequest(request: FishDialogueRequest): Record<string, unknown> {
  const canon: Record<string, unknown> = {};
  // Fixed emission order — the canonical form never depends on input order.
  canon.text = request.text;
  canon.voiceId = Array.isArray(request.voiceId)
    ? [...request.voiceId]
    : request.voiceId;
  canon.model = request.model;
  if (request.format !== undefined) canon.format = request.format;
  if (request.temperature !== undefined) canon.temperature = request.temperature;
  if (request.topP !== undefined) canon.topP = request.topP;
  if (request.sampleRate !== undefined) canon.sampleRate = request.sampleRate;
  if (request.prosody !== undefined) {
    canon.prosody = {
      speed: request.prosody.speed,
      volume: request.prosody.volume,
    };
  }
  return canon;
}

/** Stable JSON string of a request (sorted keys, fixed formatting). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Derive the versioned cache key for a request.
 * Format: `fsh1:<hex sha256 of canonical JSON>`.
 */
export function dialogueCacheKey(request: FishDialogueRequest): string {
  const canonical = stableStringify(canonicalizeRequest(request));
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${FISH_CACHE_KEY_VERSION}:${hex}`;
}

/** True when `key` has the current version prefix and 64-hex digest. */
export function isCurrentKeyFormat(key: string): boolean {
  if (!key.startsWith(`${FISH_CACHE_KEY_VERSION}:`)) return false;
  const hex = key.slice(FISH_CACHE_KEY_VERSION.length + 1);
  return /^[0-9a-f]{64}$/.test(hex);
}

/** Short display form of a key (first N hex chars) for logs/UI. */
export function displayKey(key: string): string {
  return key.slice(0, FISH_CACHE_KEY_VERSION.length + 1 + FISH_CACHE_KEY_DISPLAY_LEN);
}