/**
 * Still-motion placement + per-frame evaluation (spec §21/§22).
 *
 * `placeStillShots` maps `ai_still_motion` candidates to timeline placements
 * with resolved motion programs; `stillMotionFrame` evaluates the program at
 * one frame (pure math — the composition layer applies it to the `<Img>`).
 * Both are deterministic: same inputs → same placements → same frames.
 */

import type {
  StillMotionFrame,
  StillMotionSpec,
  StillPlacementCandidate,
  StillShotPlacement,
} from "./types.js";
import { StillMotionValidationError } from "./types.js";
import { applyEase, hashSeed, lerp, mulberry32, progress } from "./random.js";
import { HANDHELD_JITTER, parseCameraMotion } from "./parse.js";

/** Derive the effective seed for a candidate: explicit seed, else hashed
 * from shotId + motion text (stable across runs — never time-based). */
export function effectiveSeed(candidate: StillPlacementCandidate): number {
  if (candidate.seed !== undefined) {
    if (!Number.isFinite(candidate.seed)) {
      throw new StillMotionValidationError(
        `Still shot "${candidate.shotId}": seed must be a finite number`,
      );
    }
    return Math.trunc(candidate.seed) >>> 0;
  }
  return hashSeed(`${candidate.shotId}::${candidate.cameraMotion ?? ""}`);
}

/** Validate one still candidate; throws StillMotionValidationError. */
export function validateStillCandidate(candidate: StillPlacementCandidate): void {
  if (!candidate.shotId || candidate.shotId.trim().length === 0) {
    throw new StillMotionValidationError("Still candidate requires a non-empty shotId");
  }
  if (!candidate.src || candidate.src.trim().length === 0) {
    throw new StillMotionValidationError(`Still shot "${candidate.shotId}" requires a src`);
  }
  if (!Number.isInteger(candidate.durationInFrames) || candidate.durationInFrames < 1) {
    throw new StillMotionValidationError(
      `Still shot "${candidate.shotId}": durationInFrames must be an integer >= 1, got ${candidate.durationInFrames}`,
    );
  }
  if (candidate.startFrame !== undefined && (!Number.isInteger(candidate.startFrame) || candidate.startFrame < 0)) {
    throw new StillMotionValidationError(
      `Still shot "${candidate.shotId}": startFrame must be an integer >= 0, got ${candidate.startFrame}`,
    );
  }
  if (candidate.visualSource !== "ai_still_motion") {
    throw new StillMotionValidationError(
      `Shot "${candidate.shotId}" has visualSource "${candidate.visualSource}"; the still-motion layer only serves "ai_still_motion" (spec §22)`,
    );
  }
}

/**
 * Resolve one candidate into a placed still with its motion program.
 * Deterministic: same candidate → same placement + spec + seed.
 */
export function placeStillShot(candidate: StillPlacementCandidate): StillShotPlacement {
  validateStillCandidate(candidate);
  const seed = effectiveSeed(candidate);
  const motion = parseCameraMotion(candidate.cameraMotion, candidate.durationInFrames, seed);
  return {
    shotId: candidate.shotId,
    src: candidate.src,
    startFrame: candidate.startFrame ?? 0,
    durationInFrames: candidate.durationInFrames,
    motion,
    seed,
  };
}

/**
 * Place a batch of still candidates in list order. Overlapping start frames
 * are NOT an error here (compositing order = list order), but validation
 * errors name the offending shot.
 */
export function placeStillShots(candidates: readonly StillPlacementCandidate[]): StillShotPlacement[] {
  return candidates.map(placeStillShot);
}

/**
 * Evaluate the motion program at `localFrame` (0-based within the still's
 * sequence, the upstream `local_f` convention). Returns the transform to
 * apply to the still image. Deterministic: jitter is seeded from
 * `seed + localFrame`, never from time or call order.
 */
export function stillMotionFrame(
  motion: StillMotionSpec,
  localFrame: number,
  durationInFrames: number,
  seed: number,
): StillMotionFrame {
  const t = applyEase(progress(localFrame, durationInFrames), motion.ease);

  let scale = lerp(motion.scaleFrom, motion.scaleTo, t);
  let translateX = lerp(motion.translateXFrom, motion.translateXTo, t);
  let translateY = lerp(motion.translateYFrom, motion.translateYTo, t);
  let rotate = lerp(motion.rotateFrom, motion.rotateTo, t);

  if (motion.jitter > 0) {
    // Seeded per-frame jitter. Hold the generator state locally so the
    // evaluation never depends on call order or global state.
    const rand = mulberry32(hashSeed(`jitter:${seed}:${localFrame}`));
    const amp = motion.jitter;
    translateX += (rand() * 2 - 1) * HANDHELD_JITTER.translate * amp;
    translateY += (rand() * 2 - 1) * HANDHELD_JITTER.translate * amp;
    rotate += (rand() * 2 - 1) * HANDHELD_JITTER.rotate * amp;
    scale += (rand() * 2 - 1) * HANDHELD_JITTER.scale * amp;
    // Jitter must never push the image below base coverage or past the
    // travel cap (would reveal edges).
    scale = Math.max(scale, 1.0);
  }

  return {
    frame: localFrame,
    scale,
    translateX,
    translateY,
    rotate,
  };
}

/**
 * Evaluate a placed still across its whole duration. Mostly a test/inspection
 * helper (and used by frame-QA to dump expected transforms).
 */
export function stillMotionFrames(placement: StillShotPlacement): StillMotionFrame[] {
  const frames: StillMotionFrame[] = [];
  for (let f = 0; f < placement.durationInFrames; f++) {
    frames.push(stillMotionFrame(placement.motion, f, placement.durationInFrames, placement.seed));
  }
  return frames;
}

/** Convenience: is this candidate meant for the still-motion layer? */
export function isStillMotionCandidate(candidate: { visualSource: string }): boolean {
  return candidate.visualSource === "ai_still_motion";
}