/**
 * Timing conversion: alignment milliseconds → timeline frames.
 *
 * Preserves the upstream frame-discipline (spec §21 / remotion/src/shots/
 * short-6/Short6Sheet.tsx): local frame = round(global_s * fps) − from.
 * Here the whole dialogue asset is one timed span, so the conversion is
 * `frame = round(ms / 1000 * fps) + startFrame` — the same convention with
 * `from = −startFrame` (a sequence mounted at `startFrame`).
 *
 * ms→frames is done in ONE place so the caption frame and the alignment ms
 * can never drift apart (acceptance: caption frame == alignment ms→frames).
 */

import type { CaptionWord } from "./types.js";

/** Convert an alignment millisecond instant to a timeline frame number,
 * snapped with the upstream `round(global_s * fps) − from` convention. */
export function msToFrame(ms: number, fps: number, startFrame = 0): number {
  if (!Number.isFinite(ms) || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError(
      `msToFrame: expected finite ms and positive fps, got ms=${ms} fps=${fps}`,
    );
  }
  return Math.round((ms / 1000) * fps) + startFrame;
}

/** Normalize an alignment word into a caption word: finite integer ms,
 * non-negative, ordered. Returns null (never throws) for words that are
 * structurally unusable — the caller decides whether that is fatal. */
export function normalizeWord(
  input: AlignmentWordLike,
  _index: number,
): CaptionWord | null {
  const startMs = Number(input.startMs);
  const endMs = Number(input.endMs);
  if (
    typeof input.word !== "string" ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    endMs < startMs
  ) {
    return null;
  }
  return {
    word: input.word,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    ...(input.speaker !== undefined && Number.isInteger(input.speaker)
      ? { speaker: input.speaker }
      : {}),
  };
}

/** Structural input word (what FISH-006/007 hand over). */
export interface AlignmentWordLike {
  word: string;
  startMs: number;
  endMs: number;
  speaker?: number;
}