export type {
  ResolvedBoundary,
  ShotPlacement,
  TransitionKind,
  TransitionPlan,
  TransitionShot,
  TransitionSpec,
  TransitionTimeline,
  WipeDirection,
} from "./types.js";

export { TRANSITION_CATALOG, TRANSITION_KINDS, WIPE_DIRECTIONS, defaultDurationFramesFor, isTransitionKind, isWipeDirection } from "./catalog.js";
export type { TransitionDefinition } from "./catalog.js";

export {
  CROSSFADE_DEFAULT_DURATION_FRAMES,
  CUT_OVERLAP_FRAMES,
  OVERLAP_KINDS,
  WIPE_DEFAULT_DURATION_FRAMES,
  clampOverlap,
  planShotPlacements,
  resolveOverlapFrames,
} from "./overlap.js";

export { validateTransitionPlan } from "./validate.js";
export type { TransitionPlanValidation } from "./validate.js";
