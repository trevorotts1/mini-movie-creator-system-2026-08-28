/// <reference types="node" />
/**
 * FISH-003 — idempotency hashing for dialogue TTS requests.
 *
 * Runbook §38: persist a request hash/idempotency identifier where supported.
 * Fish's POST /v1/tts is synchronous (no server task id), so the request hash
 * IS the idempotency identifier: same text + voice + model + format +
 * character + settings → same hash → cache hit / reuse instead of a duplicate
 * paid synthesis.
 */
import { createHash } from "node:crypto";

/** Canonical request fingerprint input (order-independent via stable JSON). */
export interface TtsHashInput {
  characterId: string;
  voiceId: string;
  /** Spoken text (post-pronunciation-rewrite) — what actually gets spoken. */
  text: string;
  model?: string;
  format?: string;
  settings?: Record<string, unknown>;
}

/** Stable JSON stringify: object keys sorted, arrays kept in order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/**
 * SHA-256 hex request hash for a dialogue TTS request. Deterministic across
 * processes and platforms; changing any voice-defining input changes the hash
 * (a deliberate re-generation), while placement metadata (series/episode/shot)
 * never affects it. Absent and empty settings normalize to the same hash
 * (no settings ≡ empty settings — neither can change synthesis).
 */
export function hashDialogueRequest(input: TtsHashInput): string {
  const settings =
    input.settings && typeof input.settings === "object" && Object.keys(input.settings).length > 0
      ? input.settings
      : undefined;
  return createHash("sha256")
    .update("mmcs.fish-tts.v1\n")
    .update(
      stableStringify({
        characterId: input.characterId,
        voiceId: input.voiceId,
        text: input.text,
        model: input.model,
        format: input.format,
        settings,
      }),
    )
    .digest("hex");
}