import type { TransitionPlan } from "./types.js";
import { isTransitionKind, isWipeDirection } from "./catalog.js";

/**
 * Plan validation for VID-009. Validation is separate from assembly:
 * planShotPlacements is total (never throws on malformed input) so a render
 * pipeline can always run; validate/validateTransitionPlan collects every
 * issue in the plan up front so defects surface at build time, all at once.
 */

/** Non-throwing validation result. `issues` is empty when plan is valid. */
export interface TransitionPlanValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/**
 * Validates a full plan. A plan is valid when:
 * - fps is a positive finite number
 * - every shot duration is a positive integer
 * - every declared transition kind is in the catalog
 * - every wipe transition has a known direction
 * - every declared durationFrames is a positive integer
 * (A cut declaring a non-zero duration is NOT an error: overlap resolution
 * clamps it to 0 and validation documents the boundary as a cut — the plan
 * wording is redundant, not contradictory.)
 */
export function validateTransitionPlan(plan: TransitionPlan): TransitionPlanValidation {
  const issues: string[] = [];

  if (!Number.isFinite(plan.fps) || plan.fps <= 0) {
    issues.push(`fps must be a positive finite number, got ${plan.fps}`);
  }

  plan.shots.forEach((shot, index) => {
    if (!Number.isInteger(shot.durationInFrames) || shot.durationInFrames <= 0) {
      issues.push(
        `shot[${index}] "${shot.id}": durationInFrames must be a positive integer, got ${shot.durationInFrames}`,
      );
    }
    const transition = shot.transition;
    if (transition === undefined) {
      return;
    }
    if (!isTransitionKind(transition.kind)) {
      issues.push(
        `shot[${index}] "${shot.id}": unknown transition kind "${transition.kind}" (catalog: cut, crossfade, wipe)`,
      );
    }
    if (transition.kind === "wipe") {
      if (!transition.direction || !isWipeDirection(transition.direction)) {
        issues.push(
          `shot[${index}] "${shot.id}": wipe transition requires a known direction, got "${transition.direction ?? "undefined"}"`,
        );
      }
    }
    if (transition.durationFrames !== undefined) {
      if (!Number.isInteger(transition.durationFrames) || transition.durationFrames <= 0) {
        issues.push(
          `shot[${index}] "${shot.id}": durationFrames must be a positive integer, got ${transition.durationFrames}`,
        );
      }
    }
  });

  return { valid: issues.length === 0, issues };
}
