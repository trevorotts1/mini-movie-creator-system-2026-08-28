import type { RuntimeEstimatorOptions } from "./types.js";

/**
 * Estimator version. Bump when the estimation model changes materially so
 * persisted estimates stay interpretable (spec §7, §12 doctrine: derived
 * state is recorded with the algorithm that produced it).
 */
export const ESTIMATOR_VERSION = "runtime-estimator/1";

/**
 * Default pacing parameters.
 *
 * Basis (2026-08-28, calibrated against the six-beat grammar of the upstream
 * Remotion tracks where a 40–60s short is typical and dialogue beats carry
 * word-exact captions at natural speech rate):
 * - Natural English narration/speech ≈ 150 wpm ≈ 2.5 words/second.
 * - Screen action/description reads as faster montaged motion ≈ 240 wpm
 *   ≈ 4.0 words/second.
 * - Each scene carries fixed cut/establish overhead.
 * - A scene is never estimated below a minimum floor.
 *
 * These are product defaults, not measured facts — callers may override any
 * of them per estimate.
 */
export const DEFAULT_RUNTIME_ESTIMATOR_OPTIONS: Required<RuntimeEstimatorOptions> = {
  dialogueWordsPerSecond: 2.5,
  actionWordsPerSecond: 4.0,
  sceneOverheadSeconds: 1.5,
  minSceneSeconds: 3,
} as const;