/// <reference types="node" />
/**
 * Caption output shapes (FISH-007).
 *
 * Builds the word-exact caption track for ONE dialogue asset from its
 * FISH-006 alignment record — the same word-exact discipline the upstream
 * gen_voice.py pipeline enforces: every captioned word carries its REAL
 * alignment start/end (integer milliseconds, never estimated when alignment
 * exists), and delivery-direction audio tags (`[excited]`, `[pause]`, …) are
 * FILTERED out and never captioned.
 *
 * Hand-off contract:
 *   FISH-006 `FishDialogueAlignment` (via `FishAlignmentStore.getByKey`)
 *     → `buildCaptionTrack` (validate + tag-filter + cue grouping)
 *     → `CaptionTrack` (pure data, integer ms throughout)
 *     → VID-004 dialogue/captions layer renders it in the timeline
 *       (`msToFrames` provides the deterministic ms→frames conversion the
 *       VID-004 sync test asserts against).
 *
 * Cross-task note: the source is consumed STRUCTURALLY
 * (`CaptionSourceAlignment`) — FISH-006's canonical record satisfies it
 * field-for-field, but this module does not import the alignment package
 * (no cross-task dependency; FISH-006 may not be merged when this lands).
 * If FISH-006's record shape ever changes, this structural mirror must move
 * with it.
 *
 * Story/dialogue text is UNTRUSTED data (spec §21): it is stored and
 * emitted verbatim as string data — never evaluated, never interpolated
 * into executable context, never used to construct paths.
 */

/**
 * Structural input the caption builder consumes. `FishDialogueAlignment`
 * (FISH-006) satisfies this exactly; a transcription-derived record does
 * too. `key`/`durationMs` are optional here so transcription-only sources
 * can still produce a track; when present they are carried through for
 * provenance.
 */
export interface CaptionSourceAlignment {
  /** Dialogue asset key the alignment belongs to (FISH-005 cache key). */
  key?: string;
  /** Dialogue text the timings align to — the ORIGINAL script text
   * (captions must use this, never pronunciation-rewritten TTS text). */
  text: string;
  /** Word timings, integer milliseconds. Sorted by the builder. */
  words: CaptionSourceWord[];
  /** Total audio duration in ms; defaults to the last word end. Must be
   * >= the last word end when supplied (never silently clipped). */
  durationMs?: number;
}

/** One word timing as accepted from a source record (integer ms). */
export interface CaptionSourceWord {
  /** Verbatim spoken token (may include punctuation). Untrusted — stored
   * verbatim. */
  word: string;
  startMs: number;
  endMs: number;
  /** Speaker index for multi-voice (S2-family) dialogue assets. */
  speaker?: number;
}

/** One captioned word: the exact aligned timing, integers untouched. */
export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
  speaker?: number;
}

/**
 * One caption cue: a group of consecutive words displayed together. The cue
 * spans exactly its first word's start to its last word's end — no invented
 * padding (display hold/lingering is the VID-004 layer's decision).
 * `speaker` is present only when every word in the cue shares one speaker
 * index (homogeneous cue).
 */
export interface CaptionCue {
  /** The cue's words, in order, each word-exact. */
  words: CaptionWord[];
  /** First word's startMs. */
  startMs: number;
  /** Last word's endMs. */
  endMs: number;
  /** Speaker index when every word in the cue has the same one. */
  speaker?: number;
}

/**
 * The word-exact caption track for one dialogue asset. Pure data — integer
 * milliseconds only, so any consumer (VID-004) converts to frames
 * deterministically.
 */
export interface CaptionTrack {
  /** Dialogue asset key the track was built from (when the source had one). */
  sourceKey?: string;
  /** Original script text, verbatim. */
  text: string;
  /** Total audio duration in ms (>= last word end). */
  durationMs: number;
  /** Caption cues in time order; cue i ends before cue i+1 starts (a cue's
   * span never overlaps the next cue's span). */
  cues: CaptionCue[];
  /** Number of captioned words (post tag-filter). */
  wordCount: number;
  /** Options the track was built with (traceability). */
  options: CaptionBuildOptions;
  /** ISO-8601 build timestamp. */
  builtAt: string;
}

/** Options for `buildCaptionTrack`. */
export interface CaptionBuildOptions {
  /** Maximum words per cue. Default 4 (upstream chunkLines default). */
  maxWords?: number;
  /** Drop delivery-direction audio tags (`[excited]`, `[pause]`, …) — words
   * starting with `[` or ending with `]`. Default true (upstream gen_voice.py
   * discipline: tags steer delivery, they are never captioned). */
  filterDeliveryTags?: boolean;
  /** Injectable clock for `builtAt` (tests). */
  now?: () => Date;
}