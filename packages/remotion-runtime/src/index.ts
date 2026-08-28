export const MMCS_REMOTION_RUNTIME = "@mmcs/remotion-runtime scaffold marker";

export * from "./ffprobe/index.js";
export * from "./frame-extraction/index.js";

// VID-013 — selective shot replacement (spec §20/§21/§32).
export {
  SHOT_LAYER_KINDS,
  ShotReplacementError,
  type CompositionDiff,
  type EpisodicShotPlan,
  type RetryShotPlan,
  type ReplaceShotResult,
  type ShotInputs,
  type ShotLayerKind,
  type ShotReplacement,
  type ShotReplacementErrorCode,
  type ShotSegment,
  type TimedSegment,
} from "./shot-replacement/types.js";
export {
  applyRetryShot,
  diffPlans,
  inputsKey,
  isShotLayerKind,
  planRetryShot,
  replaceShot,
  timelineLayout,
  totalDurationFrames,
  validatePlan,
} from "./shot-replacement/replace.js";