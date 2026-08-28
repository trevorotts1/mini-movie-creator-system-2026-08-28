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
export * from "./intake/index.js";
