/// <reference types="node" />
/**
 * Caption build (FISH-007) — word-exact caption track from a FISH-006
 * alignment record.
 *
 * Word-exact discipline (upstream gen_voice.py, preserved verbatim):
 * - every captioned word keeps its REAL alignment start/end, converted to
 *   integer milliseconds — never re-estimated, never re-distributed;
 * - delivery-direction audio tags (`[excited]`, `[pause]`, …) are FILTERED
 *   out (never captioned) — they steer delivery, they are not spoken words;
 * - the track's `text` is the ORIGINAL script text, verbatim;
 * - cue grouping (`maxWords`, default 4) mirrors upstream chunkLines: words
 *   are sliced in order, a cue holds from its first word's start to its
 *   last word's end.
 *
 * The source alignment is UNTRUSTED data (spec §21): validated field by
 * field; malformed input throws — never silently repaired (a wrong caption
 * beat is worse than a loud failure, matching FISH-006's contract).
 */
import type {
  CaptionBuildOptions,
  CaptionCue,
  CaptionSourceAlignment,
  CaptionSourceWord,
  CaptionTrack,
  CaptionWord,
} from "./types.js";

/** Default cue size — upstream chunkLines maxWords default (remotion/src/lib/shorts.tsx). */
export const DEFAULT_MAX_WORDS = 4;

/** Maximum cue size. A caption cue longer than this is not readable. */
export const MAX_MAX_WORDS = 12;

/** True when `v` is an integer (finite, integral value). */
function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Is this token a delivery-direction audio tag rather than a spoken word?
 * Upstream gen_voice.py: tags start with `[` or end with `]` — filtered so
 * they are never captioned. */
export function isDeliveryTag(word: string): boolean {
  return word.startsWith("[") || word.endsWith("]");
}

/**
 * Validate + normalize one source word. Throws on malformed input —
 * never silently repairs timings.
 */
function normalizeWord(raw: CaptionSourceWord, path: string): CaptionWord {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${path} must be an object`);
  }
  if (typeof raw.word !== "string" || raw.word.trim() === "") {
    throw new Error(`${path}.word is required`);
  }
  if (!isInteger(raw.startMs) || !isInteger(raw.endMs)) {
    throw new Error(`${path}.startMs/.endMs must be integers (ms)`);
  }
  if (raw.endMs < raw.startMs) {
    throw new Error(
      `${path}: end (${raw.endMs}ms) is before start (${raw.startMs}ms)`,
    );
  }
  const out: CaptionWord = { word: raw.word, startMs: raw.startMs, endMs: raw.endMs };
  if (raw.speaker !== undefined) {
    if (!Number.isInteger(raw.speaker) || raw.speaker < 0) {
      throw new Error(`${path}.speaker must be a non-negative integer`);
    }
    out.speaker = raw.speaker;
  }
  return out;
}

/**
 * Build the word-exact caption track for one dialogue asset.
 *
 * Throws (never silently repairs) on malformed input:
 * - non-object source, missing/blank text, non-array words;
 * - non-integer or inverted word timings;
 * - `durationMs` present but less than the last captioned word end.
 */
export function buildCaptionTrack(
  source: CaptionSourceAlignment,
  options: CaptionBuildOptions = {},
): CaptionTrack {
  if (!source || typeof source !== "object") {
    throw new Error("caption source must be an object");
  }
  const text = source.text;
  if (typeof text !== "string") {
    throw new Error("caption source.text is required");
  }
  if (!Array.isArray(source.words)) {
    throw new Error("caption source.words must be an array");
  }
  const filterTags = options.filterDeliveryTags ?? true;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > MAX_MAX_WORDS) {
    throw new Error(
      `options.maxWords must be an integer between 1 and ${MAX_MAX_WORDS}, got ${JSON.stringify(maxWords)}`,
    );
  }

  // Validate in input order, THEN sort — stable sort keeps provider order
  // for equal timestamps (mirrors FISH-006 extraction).
  const validated = source.words.map((w, i) => normalizeWord(w, `words[${i}]`));
  const indexed = validated.map((w, i) => ({ w, i }));
  indexed.sort((a, b) => {
    if (a.w.startMs !== b.w.startMs) return a.w.startMs - b.w.startMs;
    if (a.w.endMs !== b.w.endMs) return a.w.endMs - b.w.endMs;
    return a.i - b.i;
  });
  const sorted = indexed.map((e) => e.w);

  // Upstream discipline: delivery tags are delivery directions, not spoken
  // words — never captioned.
  const captioned = filterTags
    ? sorted.filter((w) => !isDeliveryTag(w.word))
    : sorted;

  const lastEnd = captioned.length > 0 ? captioned[captioned.length - 1]!.endMs : 0;
  let durationMs: number;
  if (source.durationMs !== undefined) {
    if (!isInteger(source.durationMs)) {
      throw new Error("caption source.durationMs must be an integer (ms)");
    }
    if (source.durationMs < lastEnd) {
      throw new Error(
        `caption source.durationMs (${source.durationMs}ms) is less than the last word end (${lastEnd}ms)`,
      );
    }
    durationMs = source.durationMs;
  } else {
    durationMs = lastEnd;
  }

  const cues = groupCues(captioned, maxWords);
  const builtAt = (options.now ?? (() => new Date()))().toISOString();

  const track: CaptionTrack = {
    text,
    durationMs,
    cues,
    wordCount: captioned.length,
    options: {
      maxWords,
      filterDeliveryTags: filterTags,
    },
    builtAt,
  };
  const key = source.key?.trim();
  if (key) track.sourceKey = key;
  return track;
}

/**
 * Group captioned words into cues of at most `maxWords` consecutive words.
 * A cue spans exactly its first word's start to its last word's end — no
 * invented padding. `speaker` survives only on homogeneous cues (every word
 * shares the index), so a mixed-speaker cue never claims one speaker.
 */
function groupCues(words: readonly CaptionWord[], maxWords: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const slice = words.slice(i, i + maxWords);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    const speaker = slice.every((w) => w.speaker !== undefined && w.speaker === first.speaker)
      ? first.speaker
      : undefined;
    const cue: CaptionCue = {
      words: slice,
      startMs: first.startMs,
      endMs: last.endMs,
    };
    if (speaker !== undefined) cue.speaker = speaker;
    cues.push(cue);
  }
  return cues;
}

/**
 * Convert milliseconds to whole frames at `fps`, rounding to nearest.
 * Deterministic: same ms + same fps → same frame, always (the VID-004 sync
 * test asserts caption frame == alignment ms→frames).
 */
export function msToFrames(ms: number, fps: number): number {
  if (!isInteger(ms)) {
    throw new Error("msToFrames: ms must be an integer");
  }
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("msToFrames: fps must be a positive finite number");
  }
  return Math.round((ms / 1000) * fps);
}

/**
 * Convert whole frames back to integer milliseconds at `fps` (the inverse of
 * `msToFrames` for frame-grid values).
 */
export function framesToMs(frames: number, fps: number): number {
  if (!Number.isInteger(frames)) {
    throw new Error("framesToMs: frames must be an integer");
  }
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("framesToMs: fps must be a positive finite number");
  }
  return Math.round((frames / fps) * 1000);
}