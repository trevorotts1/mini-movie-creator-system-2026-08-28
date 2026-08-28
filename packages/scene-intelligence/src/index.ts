export {
  NEED_AXES,
  NEED_FLOOR,
  ReferenceBudgetError,
  classifyReferenceStrategy,
  needsForShotType,
  normalizeWeights,
  planReferenceBudget,
  scoreCandidate,
  type NeedAxis,
  type NeedAxisWeights,
  type ReferenceBudgetInput,
  type ReferenceBudgetOptions,
  type ReferenceBudgetPlan,
  type ReferenceBudgetSceneMaster,
  type ReferenceCandidate,
  type ReferenceCapability,
  type ReferenceHistoryOracle,
  type ReferenceStrategy,
  type ReferenceStrategyDecision,
  type ReferenceStrategyInput,
  type ReferenceSuccessRate,
  type ReferenceValueProfile,
  type SelectedReference,
  type ShotReferenceNeeds,
} from "./reference-budget/index.js";

export const MMCS_SCENE_INTELLIGENCE = "@mmcs/scene-intelligence scaffold marker";

export * from "./concept/index.js";
// Intake re-declares four shared names with identical values/behavior.
// Explicit re-export resolves the star-export ambiguity (TS2308) while
// keeping both modules' exports live.
export {
  IDEA_TEXT_MAX_LENGTH,
  IDEA_TEXT_MIN_LENGTH,
  containsNulByte,
  toSingleLine,
} from "./intake/index.js";
export * from "./intake/parse.js";
export * from "./intake/aspect-ratio.js";
export * from "./intake/sanitize.js";
export * from "./intake/types.js";
