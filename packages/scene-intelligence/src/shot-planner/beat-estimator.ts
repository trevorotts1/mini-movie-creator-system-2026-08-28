/**
 * Beat estimation — DIR-010 helper (spec §7).
 *
 * Estimates per-beat durations and derives the shot-count target for a scene
 * when the capability model cannot absorb the whole scene in one shot.
 */

import type { SceneBeat, BeatType } from "./types.js";

/** Baseline screen-time seconds per beat type before dialogue adjustment. */
export const BEAT_BASE_SECONDS: Readonly<Record<BeatType, number>> =
  Object.freeze({
    establishing: 6,
    dialogue: 8,
    reaction: 4,
    emotional: 7,
    action: 6,
    insert: 4,
  });

/** Spoken-pace seconds per dialogue word (screen convention ~2.5 wps, slightly
 * padded for AI generation timing). */
export const SECONDS_PER_DIALOGUE_WORD = 0.45;

/** Scene with fewer shots than this reads as one static clip. */
export const MIN_SHOTS_PER_SCENE = 3;

/** Spec §7: a 45-second scene is typically 5–8 shots. */
export const TYPICAL_SHOT_COUNT_MIN = 5;
export const TYPICAL_SHOT_COUNT_MAX = 8;

/**
 * Estimate a beat's screen duration in seconds. `durationHintSeconds` wins
 * when provided (positive); otherwise baseline by type plus dialogue length.
 * Result is at least 1s so every beat gets real screen time.
 */
export function estimateBeatDurationSeconds(beat: SceneBeat): number {
  if (
    beat.durationHintSeconds !== undefined &&
    beat.durationHintSeconds > 0
  ) {
    return beat.durationHintSeconds;
  }
  const words = (beat.dialogue ?? []).reduce(
    (sum, line) => sum + countWords(line.text),
    0,
  );
  const dialogueSeconds = words * SECONDS_PER_DIALOGUE_WORD;
  const base = BEAT_BASE_SECONDS[beat.type] ?? 6;
  return Math.max(1, round1(base + dialogueSeconds));
}

/** Estimated scene duration from its beats. */
export function estimateSceneDurationSeconds(beats: readonly SceneBeat[]): number {
  return round1(beats.reduce((sum, b) => sum + estimateBeatDurationSeconds(b), 0));
}

/**
 * Desired shot count for a scene of `durationSeconds`: roughly one shot per
 * 7 seconds, clamped to the spec-typical 5–8 band for a 45s scene and never
 * below MIN_SHOTS_PER_SCENE for any scene that has beats.
 */
export function desiredShotCount(durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const byPace = durationSeconds / 7;
  const clamped = Math.min(TYPICAL_SHOT_COUNT_MAX, Math.max(TYPICAL_SHOT_COUNT_MIN, Math.round(byPace)));
  return Math.max(MIN_SHOTS_PER_SCENE, clamped);
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}