/// <reference types="node" />
/**
 * Alignment/timestamp data shapes (FISH-006).
 *
 * Runbook §8: Fish Audio subsystem provides "per-word timing where available";
 * WF06-004 owns the "timestamp/alignment/caption pipeline". This module owns
 * the canonical word/phoneme timing record for ONE dialogue asset and its
 * durable persistence. FISH-007 (caption output) consumes the alignment doc
 * exported here — via `FishAlignmentStore.getByKey` — to build word-synced
 * captions; nothing in this module formats captions.
 *
 * Hand-off contract:
 *   FISH-001/003 client → raw provider alignment payload (untrusted)
 *     → `extractAlignment` (normalize + validate) → `FishDialogueAlignment`
 *     → `FishAlignmentStore.save` (durable, keyed by the FISH-005 dialogue
 *       cache key of the asset the audio came from)
 *     → FISH-007 reads timings with `FishAlignmentStore.get`.
 *
 * Dialogue/story text is UNTRUSTED data (spec §21): it is stored verbatim,
 * hashed-adjacent (the key is already a digest), never evaluated, and never
 * used to construct file paths (the file name is the hex digest key).
 */

/** The dialogue asset a timing record belongs to: the FISH-005 dialogue cache
 * key (`fsh1:<64 hex chars>`). Alignment is always persisted PER ASSET — the
 * same request key always maps to the same audio and the same timings. */
export type FishDialogueAssetKey = string;

/** Time units a provider alignment payload may arrive in. */
export type FishAlignmentTimeUnit =
  | "ms"
  | "millisecond"
  | "milliseconds"
  | "s"
  | "sec"
  | "seconds";

/** A phoneme-level timing as emitted by the provider (times in `timeUnit`). */
export interface FishAlignedPhonemePayload {
  /** Phoneme label (ARPAbet, IPA, or provider-native). Stored verbatim. */
  phoneme: string;
  start: number;
  end: number;
}

/** A word-level timing as emitted by the provider (times in `timeUnit`). */
export interface FishAlignedWordPayload {
  /** The spoken token exactly as the provider emitted it (may include
   * punctuation). Untrusted — stored verbatim. */
  word: string;
  start: number;
  end: number;
  /** Optional speaker index for multi-voice (S2-family) dialogue assets. */
  speaker?: number;
  /** Optional phoneme breakdown for this word. */
  phonemes?: FishAlignedPhonemePayload[];
}

/**
 * The raw alignment payload captured from the provider for one dialogue
 * asset. Fish Audio's exact timestamp surface varies by model/route; this is
 * the normalized contract the Fish client (FISH-001/003) maps provider
 * responses into before hand-off.
 */
export interface FishAlignmentPayload {
  /** Dialogue text the timings were measured against. */
  text?: string;
  /** Total audio duration, in `timeUnit` (optional). */
  duration?: number;
  /** Unit of all times in this payload. Default "ms". */
  timeUnit?: FishAlignmentTimeUnit;
  /** Word timings. */
  words: FishAlignedWordPayload[];
}

/** A phoneme timing in the canonical record (milliseconds, integers). */
export interface FishAlignedPhoneme {
  phoneme: string;
  startMs: number;
  endMs: number;
}

/** A word timing in the canonical record (milliseconds, integers). */
export interface FishAlignedWord {
  /** Verbatim spoken token from the provider. */
  word: string;
  startMs: number;
  endMs: number;
  /** Speaker index when the provider supplied one (multi-voice dialogue). */
  speaker?: number;
  /** Phoneme breakdown when the provider supplied one. */
  phonemes?: FishAlignedPhoneme[];
}

/** How the timings were obtained. */
export type FishDialogueAlignmentSource =
  | "provider_response"
  | "transcription";

/**
 * The canonical per-dialogue-asset alignment record (the thing FISH-007
 * consumes). Immutable once persisted; regenerate by re-extracting.
 */
export interface FishDialogueAlignment {
  /** Dialogue asset key this record belongs to (FISH-005 cache key). */
  key: FishDialogueAssetKey;
  /** Dialogue text the timings align to — the ORIGINAL script text
   * (captions must use this, never pronunciation-rewritten TTS text). */
  text: string;
  /** Fish model that produced the audio (traceability; config-driven). */
  model?: string;
  /** How the timings were obtained. */
  source: FishDialogueAlignmentSource;
  /** Word timings, sorted by startMs (ties: endMs, then provider order). */
  words: FishAlignedWord[];
  /** Total audio duration in ms: the provider duration when supplied,
   * otherwise the last word end. Always >= the last word end. */
  durationMs: number;
  /** ISO-8601 extraction timestamp. */
  extractedAt: string;
}

/** The on-disk document shape (one file per key). Versioned for evolution. */
export interface FishAlignmentFile {
  formatVersion: 1;
  alignment: FishDialogueAlignment;
}