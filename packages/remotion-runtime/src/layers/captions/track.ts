/**
 * Word-exact caption track construction from Fish alignment (VID-004,
 * spec §21; acceptance: "word-exact captions from FISH-007 alignment").
 *
 * Word-exactness discipline (port of upstream tools/gen_voice.py):
 * captions use the alignment words VERBATIM and their measured times —
 * text is never re-tokenized or re-punctuated when timing exists. The
 * caption track is the alignment, converted to frames; grouping into
 * chunks (≤ maxWords, speaker-separated) only changes WHAT is shown
 * together, never any word's timing.
 *
 * Untrusted data (spec §21): dialogue text/words are carried verbatim and
 * only ever surfaced as opaque strings. A word whose STRUCTURE is broken
 * (non-finite/negative ms) is skipped and counted — its CONTENT is never
 * parsed to "fix" it.
 */

import { CaptionTrackError } from "./errors.js";
import { msToFrame, normalizeWord, type AlignmentWordLike } from "./timing.js";
import type {
  AlignmentTrackInput,
  CaptionChunk,
  CaptionTrack,
  CaptionWord,
} from "./types.js";

/** Chunk-hold discipline, ported from the upstream Shorts kit
 * (remotion/src/lib/shorts.tsx chunkLines): a chunk holds until the next
 * chunk starts or its end + tail, whichever is earlier; the final chunk
 * holds its end + the last tail. Values in SECONDS upstream; converted
 * with the same fps as the track. */
export const CHUNK_TAIL_S = 0.6;
export const LAST_TAIL_S = 0.8;

/** Defaults shared with the upstream Shorts kit Captions component. */
export const CAPTION_DEFAULTS = {
  y: 1280,
  size: 58,
  accent: "#f5d76e",
  maxWords: 4,
  plate: false,
} as const;

/**
 * Build a word-exact caption track from a FISH-007/006 alignment input.
 *
 * @param input   structural alignment. Accepts EITHER a flat word list
 *                (`words` — the FISH-006 alignment record) OR FISH-007's
 *                cue-grouped CaptionTrack output (`cues`), so the production
 *                hand-off (FISH-007 builds → VID-004 renders) works as-is.
 * @param fps     composition fps the frames are computed at.
 * @param options `startFrame` mounts the dialogue audio at a global frame
 *                (0 = composition start); `assetKey` records provenance
 *                (defaults to FISH-007's `sourceKey` when present).
 * @returns immutable CaptionTrack; every frame number derives from the
 *          alignment ms by `msToFrame`.
 * @throws CaptionTrackError when there are no usable words (an episode
 *         with dialogue must never silently render no captions).
 */
export function buildCaptionTrack(
  input: AlignmentTrackInput,
  fps: number,
  options: { startFrame?: number; assetKey?: string | null } = {},
): CaptionTrack {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new CaptionTrackError(
      `buildCaptionTrack: fps must be a positive finite number, got ${fps}`,
    );
  }
  const startFrame = options.startFrame ?? 0;
  if (!Number.isInteger(startFrame) || startFrame < 0) {
    throw new CaptionTrackError(
      `buildCaptionTrack: startFrame must be a non-negative integer, got ${startFrame}`,
    );
  }
  // FISH-007 hands over cue groups; FISH-006 hands over flat words. Flatten
  // cues into the word stream — the track's word list is the alignment
  // either way, and chunkTrack re-groups for display.
  const rawWords: ReadonlyArray<AlignmentWordLike> = Array.isArray(input?.words)
    ? input.words
    : Array.isArray(input?.cues)
      ? input.cues.flatMap((cue) =>
          Array.isArray(cue?.words) ? cue.words : [],
        )
      : [];
  if (rawWords.length === 0) {
    throw new CaptionTrackError(
      "buildCaptionTrack: alignment has no words — cannot build a caption track",
    );
  }

  const skipped: number[] = [];
  const words: CaptionWord[] = [];
  rawWords.forEach((w, i) => {
    const norm = normalizeWord(w, i);
    if (norm) words.push(norm);
    else skipped.push(i);
  });
  if (words.length === 0) {
    throw new CaptionTrackError(
      `buildCaptionTrack: ${skipped.length} of ${rawWords.length} alignment words unusable (non-finite or negative timings)`,
    );
  }

  // Sort by startMs (ties by endMs then input order) — same discipline as
  // FISH-006's canonical record, re-asserted here because the input is
  // structural, not a trusted import.
  const sorted = words
    .map((w, i) => ({ w, i }))
    .sort(
      (a, b) =>
        a.w.startMs - b.w.startMs ||
        a.w.endMs - b.w.endMs ||
        a.i - b.i,
    )
    .map(({ w }) => w);

  const lastEndMs = Math.max(...sorted.map((w) => w.endMs));
  const durationMs = Math.max(Number(input.durationMs) || 0, lastEndMs);

  return Object.freeze({
    assetKey: options.assetKey ?? input.sourceKey ?? null,
    text: typeof input.text === "string" ? input.text : "",
    fps,
    startFrame,
    durationFrames: msToFrame(durationMs, fps, startFrame),
    words: Object.freeze(sorted),
  });
}

/**
 * Group track words into caption chunks of ≤ maxWords consecutive words,
 * never mixing speakers in one chunk (S2-family multi-voice dialogue).
 * Chunk frames come from the track's own ms→frames conversion — no second
 * timing source exists.
 */
export function chunkTrack(
  track: CaptionTrack,
  maxWords: number = CAPTION_DEFAULTS.maxWords,
): CaptionChunk[] {
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new CaptionTrackError(
      `chunkTrack: maxWords must be a positive integer, got ${maxWords}`,
    );
  }
  const tailFrames = Math.max(1, Math.round(CHUNK_TAIL_S * track.fps));
  const lastTailFrames = Math.max(1, Math.round(LAST_TAIL_S * track.fps));

  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  let currentSpeaker: number | undefined;
  for (const word of track.words) {
    const speakerChanged =
      currentSpeaker !== undefined && word.speaker !== currentSpeaker;
    if (current.length >= maxWords || speakerChanged) {
      groups.push(current);
      current = [];
      currentSpeaker = undefined;
    }
    if (current.length === 0) currentSpeaker = word.speaker;
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  // Build in two passes: boundaries first, then holds (hold needs the next
  // chunk's start). CaptionChunk fields are readonly — compose fully-formed.
  // Groups are never empty (each holds ≥1 pushed word), so first/last are
  // always present; assert instead of sprinkling non-null assertions.
  const boundaries = groups.map((ws) => {
    const first = ws[0];
    const last = ws[ws.length - 1];
    if (!first || !last) {
      throw new CaptionTrackError(
        "chunkTrack: internal error — empty word group",
      );
    }
    return {
      words: Object.freeze(ws),
      startFrame: msToFrame(first.startMs, track.fps, track.startFrame),
      endFrame: msToFrame(last.endMs, track.fps, track.startFrame),
    };
  });

  const chunks: CaptionChunk[] = boundaries.map((b, i) => {
    const next = boundaries[i + 1];
    const endHold = b.endFrame + (next ? tailFrames : lastTailFrames);
    return {
      ...b,
      holdFrame: next ? Math.min(next.startFrame, endHold) : endHold,
    };
  });
  return chunks;
}

/**
 * Which chunk is on screen at a given frame (undefined = none: between
 * lines or outside the track). Mirrors the upstream `chunks.find(c => t >=
 * c.start && t < c.hold)` gate, in frame space.
 */
export function activeChunkAt(
  chunks: ReadonlyArray<CaptionChunk>,
  frame: number,
): CaptionChunk | undefined {
  return chunks.find((c) => frame >= c.startFrame && frame < c.holdFrame);
}

/**
 * Which word of a chunk is being SPOKEN at a given frame. The alignment's
 * own ms boundaries are authoritative: a word is active from its
 * msToFrame(start) through msToFrame(end) − 1 (the frame whose time span
 * contains the word's end instant has ended). `startFrame` is the track's
 * global mount point (chunk frames already include it — word boundaries
 * must too, or the highlight fires `startFrame` frames early). The
 * upstream kit adds a 0.05s visual grace on the highlight; the boundary
 * returned here stays the alignment's.
 */
export function activeWordAt(
  chunk: CaptionChunk,
  frame: number,
  fps: number,
  startFrame = 0,
): CaptionWord | undefined {
  return chunk.words.find((w) => {
    const start = msToFrame(w.startMs, fps, startFrame);
    const end = msToFrame(w.endMs, fps, startFrame);
    return frame >= start && frame < end;
  });
}