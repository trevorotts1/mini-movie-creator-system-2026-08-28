/**
 * Still-image motion layer types (spec §21, §22).
 *
 * Spec §22 visual type 2: "AI still with Remotion motion/camera treatment".
 * Remotion owns "camera movement on stills" (§21). This layer turns the
 * free-form `camera_motion` field of the §12 Shot Specification Record into
 * a deterministic motion program, and evaluates that program per frame.
 *
 * The layer is pure TypeScript (no React/Remotion imports): the rough-cut
 * composition (VID-012) applies the returned per-frame transforms to the
 * still's `<Img>` element. Determinism is the contract — same inputs
 * (motion text, duration, seed) must produce identical frames every run.
 */

/** The four visual source types per spec §22 (shared vocabulary with the
 * stock layer; `ai_still_motion` is the one this layer serves). */
export type VisualSourceType =
  | "generated_character_video"
  | "ai_still_motion"
  | "stock_broll"
  | "native_graphics";

/** Canonical motion kinds the layer can emit. */
export type CameraMotionKind =
  | "static"
  | "zoom_in"
  | "zoom_out"
  | "pan"
  | "tilt"
  | "drift"
  | "crane"
  | "tracking"
  | "handheld"
  | "whip_pan";

/** Easing curve applied to the motion program. */
export type MotionEase = "linear" | "ease_in_out" | "ease_out";

/**
 * A resolved, deterministic motion program for one still shot.
 *
 * All values are in the same units the composition applies directly:
 * `scale` is a multiplier (1 = fills frame), `translateX`/`translateY` are
 * percentages of the image size, `rotate` is degrees. `from` values are the
 * transform at the first frame, `to` values at the last frame.
 */
export interface StillMotionSpec {
  readonly kind: CameraMotionKind;
  readonly scaleFrom: number;
  readonly scaleTo: number;
  readonly translateXFrom: number;
  readonly translateXTo: number;
  readonly translateYFrom: number;
  readonly translateYTo: number;
  readonly rotateFrom: number;
  readonly rotateTo: number;
  readonly ease: MotionEase;
  /**
   * Handheld-style jitter amplitude (percent translate / degrees rotate /
   * scale delta). 0 for non-handheld kinds. Jitter is seeded — same seed,
   * same jitter.
   */
  readonly jitter: number;
}

/** A still shot offered to the layer for placement. */
export interface StillPlacementCandidate {
  readonly shotId: string;
  readonly visualSource: VisualSourceType;
  /** Free-form `camera_motion` text from the §12 shot record. */
  readonly cameraMotion?: string;
  /** Still image source (staticFile path or URL). */
  readonly src: string;
  /** Shot length in frames. Must be >= 1. */
  readonly durationInFrames: number;
  /** Desired start on the episode timeline, in frames. Defaults to 0. */
  readonly startFrame?: number;
  /**
   * Determinism seed. When omitted, a stable seed is derived from the shot
   * id + motion text, so identical inputs still render identical frames.
   */
  readonly seed?: number;
}

/** A still shot placed on the episode timeline with its motion program. */
export interface StillShotPlacement {
  readonly shotId: string;
  readonly src: string;
  readonly startFrame: number;
  readonly durationInFrames: number;
  readonly motion: StillMotionSpec;
  readonly seed: number;
}

/** Per-frame transform for one still (pure data — no React). */
export interface StillMotionFrame {
  readonly frame: number;
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
  readonly rotate: number;
}

/** Thrown on invalid still-motion input (bad duration, missing src…). */
export class StillMotionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StillMotionValidationError";
  }
}
