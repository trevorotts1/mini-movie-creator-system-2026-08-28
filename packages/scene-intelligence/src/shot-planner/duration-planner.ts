/**
 * Duration planning — DIR-010 (spec §7: "keep shots inside the selected
 * model's duration limits").
 *
 * Distributes a scene's total duration across the desired shot count, then
 * adapts each target into the selected model's feasible window:
 *  - scene fits in one model window → single shot at scene duration
 *  - model max < needed per-shot duration → more shots (split) so every shot
 *    fits the model max
 *  - model min > natural shot duration → shots lengthened to the model min
 *    (fewer shots only if that keeps every shot ≤ max)
 *  - UNKNOWN (null) limits are treated as unconstrained with a warning —
 *    never invented (spec §5).
 */

import {
  ShotPlannerValidationError,
  type VideoModelConstraints,
} from "./types.js";

/** A concrete per-shot duration assignment. */
export interface DurationAssignment {
  readonly shotCount: number;
  /** Per-shot target durations, seconds, in sequence order. */
  readonly durations: number[];
  /** True when limits were UNKNOWN and treated as unconstrained. */
  readonly usedUnknownLimits: boolean;
}

/**
 * Decide shot count + per-shot durations for a scene against model limits.
 *
 * `sceneDurationSeconds` must be > 0. `desiredShots` is the beat/pace-driven
 * target (see `desiredShotCount`); the model window may raise it (splitting)
 * or lower it toward 1 (merging) while keeping shots inside limits and the
 * sum equal to the scene duration (± rounding, normalized on the last shot).
 */
export function planDurations(
  sceneDurationSeconds: number,
  desiredShots: number,
  constraints: VideoModelConstraints,
): DurationAssignment {
  if (!Number.isFinite(sceneDurationSeconds) || sceneDurationSeconds <= 0) {
    throw new ShotPlannerValidationError(
      `scene duration must be a positive number of seconds, got ${sceneDurationSeconds}`,
    );
  }
  if (!Number.isInteger(desiredShots) || desiredShots < 1) {
    throw new ShotPlannerValidationError(
      `desired shot count must be a positive integer, got ${desiredShots}`,
    );
  }

  const min = constraints.minDurationSeconds;
  const max = constraints.maxDurationSeconds;
  const usedUnknownLimits = min === null || max === null;

  const maxPer = max ?? Number.POSITIVE_INFINITY;
  const minPer = min ?? 0;

  if (minPer > maxPer) {
    throw new ShotPlannerValidationError(
      `model ${constraints.modelId} has minDurationSeconds ${minPer} > maxDurationSeconds ${maxPer}`,
    );
  }
  if (sceneDurationSeconds < minPer) {
    throw new ShotPlannerValidationError(
      `scene duration ${sceneDurationSeconds}s is below model ${constraints.modelId} minimum clip length ${minPer}s`,
    );
  }

  // UNKNOWN limits: no window to fit — honor the desired count verbatim.
  if (usedUnknownLimits) {
    return finalize(
      desiredShots,
      distribute(sceneDurationSeconds, desiredShots),
      true,
    );
  }

  // One shot covers the scene entirely when the model window allows it and
  // the single scene-length clip satisfies the model minimum.
  if (sceneDurationSeconds <= maxPer && sceneDurationSeconds >= minPer) {
    return finalize(1, [sceneDurationSeconds], usedUnknownLimits);
  }

  // Otherwise: pick the shot count that satisfies both the desired target
  // (5–8 typical) and the model window. Splitting beats quality: never emit
  // a shot longer than the model max.
  let shotCount = Math.max(desiredShots, Math.ceil(sceneDurationSeconds / maxPer));

  // Raising the count for splitting must not push per-shot duration below
  // the model minimum; if it does, fewer shots are the only feasible option.
  while (shotCount > 1 && sceneDurationSeconds / shotCount < minPer) {
    shotCount -= 1;
  }
  // If even one shot cannot cover the scene within max (impossible given the
  // split above, but guarded), fail loudly rather than emit an illegal shot.
  if (sceneDurationSeconds / shotCount > maxPer && maxPer !== Number.POSITIVE_INFINITY) {
    throw new ShotPlannerValidationError(
      `scene duration ${sceneDurationSeconds}s cannot fit model ${constraints.modelId} window ${minPer}–${maxPer}s`,
    );
  }

  const durations = distribute(sceneDurationSeconds, shotCount);
  return finalize(shotCount, lengthsToMin(durations, minPer), usedUnknownLimits);
}

/**
 * Split one shot that exceeds the model max into consecutive feasible shots
 * (used when a beat-level target overshoots the window). Returns the split
 * durations summing to `duration`.
 */
export function splitToWindow(duration: number, constraints: VideoModelConstraints): number[] {
  const max = constraints.maxDurationSeconds ?? Number.POSITIVE_INFINITY;
  const min = constraints.minDurationSeconds ?? 0;
  if (duration <= max) return [duration];
  const parts = Math.ceil(duration / max);
  const per = duration / parts;
  if (per < min) {
    throw new ShotPlannerValidationError(
      `cannot split ${duration}s into ${parts} parts within ${min}–${max}s window`,
    );
  }
  return distribute(duration, parts);
}

/** Even distribution of `total` across `parts`, last part absorbs rounding. */
function distribute(total: number, parts: number): number[] {
  const each = Math.round((total / parts) * 10) / 10;
  const durations = Array.from({ length: parts }, () => each);
  const assigned = each * (parts - 1);
  const last = Math.round((total - assigned) * 10) / 10;
  durations[parts - 1] = last;
  return durations;
}

/** Clamp each duration up to the model minimum (unknown min → unchanged). */
function lengthsToMin(durations: number[], minPer: number): number[] {
  if (minPer <= 0) return durations;
  return durations.map((d) => (d < minPer ? minPer : d));
}

function finalize(
  shotCount: number,
  durations: number[],
  usedUnknownLimits: boolean,
): DurationAssignment {
  return { shotCount, durations, usedUnknownLimits };
}