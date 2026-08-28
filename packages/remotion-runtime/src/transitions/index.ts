export type {
  ResolvedBoundary,
  ShotPlacement,
  TransitionKind,
  TransitionPlan,
  TransitionShot,
  TransitionSpec,
  TransitionTimeline,
  WipeDirection,
} from "./types";

export { TRANSITION_CATALOG, TRANSITION_KINDS, WIPE_DIRECTIONS, defaultDurationFramesFor, isTransitionKind, isWipeDirection } from "./catalog";
export type { TransitionDefinition } from "./catalog";

export {
  CROSSFADE_DEFAULT_DURATION_FRAMES,
  CUT_OVERLAP_FRAMES,
  OVERLAP_KINDS,
  WIPE_DEFAULT_DURATION_FRAMES,
  clampOverlap,
  planShotPlacements,
  resolveOverlapFrames,
} from "./overlap";

export { validateTransitionPlan } from "./validate";
export type { TransitionPlanValidation } from "./validate";
