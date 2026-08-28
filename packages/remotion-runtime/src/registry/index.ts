/**
 * Episodic composition registry (spec §21). Resolves a DB-derived plan into
 * one Remotion composition per episode with scene/shot frame offsets.
 */
export type {
  EpisodeCompositionConfig,
  EpisodeCompositionRegistry,
  EpisodicPlan,
  EpisodePlan,
  SceneCompositionConfig,
  ScenePlan,
  SeriesPlan,
  ShotCompositionConfig,
  ShotPlan,
} from "./types.js";
export {
  buildEpisodeCompositionRegistry,
  getCompositionForEpisode,
  shotDurationInFrames,
} from "./build.js";
export { formatEpisodeCode, RegistryPlanError, validatePlan, validateSeries } from "./validate.js";