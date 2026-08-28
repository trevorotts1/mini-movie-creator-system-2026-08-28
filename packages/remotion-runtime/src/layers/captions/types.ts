/**
 * Dialogue/captions layer data shapes (VID-004, spec §21 — Remotion owns
 * captions; the dialogue/captions layer is one of the episodic timeline
 * layers).
 *
 * Hand-off contract:
 *   FISH-006 alignment (word-level ms timings, persisted per dialogue asset)
 *     → FISH-007 caption output (word-exact caption track)
 *     → VID-004 renders that track on the episodic timeline.
 *
 * FISH-006/FISH-007 are not importable from this package yet (separate
 * packages, merged independently), so the input here is the STRUCTURAL
 * subset of the Fish alignment record: `{ text, durationMs, words:
 * [{ word, startMs, endMs, speaker? }] }`. FISH-007's output satisfies it
 * as-is (its words are the alignment words verbatim; times are ms).
 *
 * Dialogue/story text is UNTRUSTED data (spec §21): it is carried verbatim,
 * never evaluated, never used to build file paths, and only ever rendered as
 * React text nodes. Timing math never trusts word CONTENT — only numbers.
 */

/** A dialogue asset key (FISH-005 cache key of the audio the alignment
 * came from). Opaque string — provenance only. */
export type DialogueAssetKey = string;

/** One spoken word with its measured timing, in milliseconds. */
export interface CaptionWord {
  /** Verbatim spoken token from the alignment (may carry punctuation).
   * Untrusted — rendered as-is, never parsed. */
  readonly word: string;
  /** Word start, ms relative to the dialogue asset's audio start. */
  readonly startMs: number;
  /** Word end, ms relative to the dialogue asset's audio start. */
  readonly endMs: number;
  /** Speaker index for multi-voice (S2-family) dialogue assets. */
  readonly speaker?: number;
}

/** The structural subset of a Fish dialogue alignment record this layer
 * consumes. `FishDialogueAlignment` (FISH-006) satisfies this interface. */
export interface AlignmentTrackInput {
  /** Dialogue text the timings align to — the ORIGINAL script text.
   * Captions must use this, never pronunciation-rewritten TTS text. */
  readonly text?: string;
  /** Total audio duration in ms (optional; falls back to the last word end). */
  readonly durationMs?: number;
  /** Word timings, in ms relative to the audio start. */
  readonly words: ReadonlyArray<AlignmentWordInput>;
}

/** Loose word shape accepted on input (numbers may need normalization). */
export interface AlignmentWordInput {
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker?: number;
}

/** A caption group shown on screen at once: up to `maxWords` consecutive
 * words of one speaker. Ported from the upstream Shorts kit `chunkLines`
 * discipline (remotion/src/lib/shorts.tsx). */
export interface CaptionChunk {
  readonly words: readonly CaptionWord[];
  /** First word start, in frames (timeline space, see `msToFrame`). */
  readonly startFrame: number;
  /** Last word end, in frames. */
  readonly endFrame: number;
  /** The chunk stays visible until this frame: the next chunk's start, or
   * this chunk's end + the between-lines tail (whichever is earlier); the
   * final chunk holds end + the last-line tail. In frames. */
  readonly holdFrame: number;
}

/** A complete word-exact caption track for one dialogue asset, already
 * converted to timeline frames at a fixed fps. */
export interface CaptionTrack {
  /** Dialogue asset the captions came from (provenance; may be absent when
   * converting an unkeyed alignment input). */
  readonly assetKey: DialogueAssetKey | null;
  /** The original script text carried through verbatim (untrusted). */
  readonly text: string;
  /** fps the frame numbers were computed at. */
  readonly fps: number;
  /** Track start offset in frames: where the dialogue audio begins on the
   * global timeline (0 = composition start). */
  readonly startFrame: number;
  /** Last word end (or audio duration, whichever is later), in frames. */
  readonly durationFrames: number;
  /** Word timings in frames, sorted by startFrame. */
  readonly words: readonly CaptionWord[];
}

/** Style options for the caption renderer (upstream Shorts kit defaults). */
export interface CaptionStyleOptions {
  /** Vertical center of the caption block, px. Default 1280 (above the
   * Shorts/Reels/TikTok UI safe zone). */
  readonly y?: number;
  /** Font size, px. Default 58. */
  readonly size?: number;
  /** Accent color for the currently-spoken word. Default "#f5d76e". */
  readonly accent?: number | string;
  /** Max words on screen at once. Default 4. */
  readonly maxWords?: number;
  /** Dark pill behind the words — for light scenes. Default false. */
  readonly plate?: boolean;
  /** Font family override; defaults to a bold display stack. */
  readonly fontFamily?: string;
}