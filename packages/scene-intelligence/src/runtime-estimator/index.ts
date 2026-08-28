export {
  countWords,
  roundSeconds,
  validateOptions,
  validateScreenplayInput,
} from "./count-words.js";

export {
  DEFAULT_RUNTIME_ESTIMATOR_OPTIONS,
  ESTIMATOR_VERSION,
} from "./defaults.js";

export {
  estimateScene,
  estimateRuntime,
  isValidRuntimeEstimate,
} from "./estimate.js";

export {
  KNOWN_DURATION_FIXTURES,
  COFFEE_AT_DAWN,
  ROOFTOP_PURSUIT,
  QUIET_HOURS,
  type KnownDurationFixture,
} from "./fixtures.js";

export { RuntimeEstimateStore } from "./store.js";

export {
  RUNTIME_ESTIMATOR_INPUT_VERSION,
  SCREENPLAY_ELEMENT_KINDS,
  RuntimeEstimatorError,
  type ResolvedRuntimeEstimatorOptions,
  type RuntimeEstimate,
  type RuntimeEstimatorOptions,
  type SceneEstimate,
  type ScreenplayElement,
  type ScreenplayElementKind,
  type ScreenplayInput,
  type ScreenplaySceneInput,
} from "./types.js";