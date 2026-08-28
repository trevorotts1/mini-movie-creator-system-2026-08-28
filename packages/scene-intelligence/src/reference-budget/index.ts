/**
 * ReferenceBudgetPlanner for Scene Intelligence (spec §8 "Keyframe /
 * Scene-master classification + reference budget"; runbook §17.1).
 *
 * MINIMUM SUFFICIENT references per shot — never fill the model's maximum
 * just because it exists. The planner scores every candidate reference on
 * the eight spec-defined dimensions (identity, wardrobe, location, prop,
 * pose/composition, starting-state, ending-state, model-specific historical
 * success), then selects greedily by weighted score until the shot's needs
 * are covered, stopping well short of the provided ceiling whenever
 * possible.
 *
 * Pure module — no I/O, no fetch. The planner takes an injected history
 * oracle so the persistence implementation (CHAR-015 refpack-metrics
 * `RefpackMetricsStore`, once merged) plugs in behind the same shape
 * (`{samples, accepted, rejected, rate}`); with no oracle the historical
 * term is neutral (0.5) and never conflates "no history" with "always
 * fails".
 */

/* ------------------------------------------------------------------ */
/* Strategy classification                                             */
/* ------------------------------------------------------------------ */

/**
 * Mutually exclusive keyframe/reference strategies (spec §8). The strategy
 * taxonomy names the bucket; scene-master presence is a separate flag
 * (see {@link ReferenceBudgetInput.sceneMaster}).
 */
export type ReferenceStrategy =
  | "zero-keyframes"
  | "one-starting-keyframe"
  | "start-end-keyframes"
  | "scene-master-plus-references"
  | "multimodal-reference-package";

/** Error thrown on invalid reference-budget operations. */
export class ReferenceBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceBudgetError";
  }
}

/** The eight spec §8 scoring dimensions (also the need axes). */
export const NEED_AXES = [
  "identity",
  "wardrobe",
  "location",
  "prop",
  "pose",
  "startState",
  "endState",
] as const;

export type NeedAxis = (typeof NEED_AXES)[number];

/** Reference value profile: 0..1 per axis; absent axis = 0 (does not help). */
export type ReferenceValueProfile = Partial<Record<NeedAxis, number>>;

/** Shot reference needs: importance 0..1 per axis. */
export type ShotReferenceNeeds = Record<NeedAxis, number>;

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** A reference candidate image the planner may select. */
export interface ReferenceCandidate {
  /** MMCS asset ID (spec §9/§19 linkage), e.g. "ASSET_CHAR_REF_001". */
  assetId: string;
  /** Character the asset belongs to, when character-scoped. */
  characterId?: string;
  /** What kind of asset this is; the value profile carries the detail. */
  kind:
    | "identity"
    | "wardrobe"
    | "location"
    | "prop"
    | "pose"
    | "scene-master"
    | "keyframe-start"
    | "keyframe-end";
  /** 0..1 value per axis the asset contributes (absent = 0). */
  valueProfile: ReferenceValueProfile;
  /** True for an exact-start-keyframe candidate. */
  isStartFrame?: boolean;
  /** True for an exact-end-keyframe candidate. */
  isEndFrame?: boolean;
}

/** Model reference-input capability (CAP-001 schema `references` block). */
export interface ReferenceCapability {
  /** Known ceiling; null = unknown, never invented. */
  maxImages: number | null;
  firstFrame: boolean;
  lastFrame: boolean;
  firstLastFrame: boolean;
  multimodalReferences: boolean;
  allowedReferenceTypes: string[] | null;
  incompatibleCombinations: string[] | null;
}

/**
 * Historical success shapes (spec §8 axis 8). Mirrors CHAR-015
 * refpack-metrics `SuccessRate` so a wrapper around `RefpackMetricsStore`
 * plugs in without translation.
 */
export interface ReferenceSuccessRate {
  samples: number;
  accepted: number;
  rejected: number;
  /** accepted/samples in [0,1]; null when no samples (neutral, never 0). */
  rate: number | null;
}

/**
 * Injected history oracle. Defaults to null-neutral when absent.
 * `at` (ISO instant) lets decision-time queries exclude future outcomes
 * (CHAR-015 `successRateForReference(characterId, model, referenceId, at)`).
 */
export interface ReferenceHistoryOracle {
  successRateForReference(
    characterId: string,
    model: string,
    referenceId: string,
    at?: string,
  ): Promise<ReferenceSuccessRate> | ReferenceSuccessRate;
  successRateForPack?(
    characterId: string,
    model: string,
    referenceIds: readonly string[],
    at?: string,
  ): Promise<ReferenceSuccessRate> | ReferenceSuccessRate;
}

/** An approved (or not-yet-approved) scene master for the shot's scene. */
export interface ReferenceBudgetSceneMaster {
  assetId: string;
  approved: boolean;
  valueProfile: ReferenceValueProfile;
}

/** Weighting for scoring axes. 0 disables the axis. */
export type NeedAxisWeights = Partial<Record<NeedAxis, number>>;

/** Options for {@link planReferenceBudget}. */
export interface ReferenceBudgetOptions {
  /**
   * Scoring weights per axis. Defaults: identity 1.0, startState 0.8,
   * endState 0.8, wardrobe 0.6, location 0.5, pose 0.5, prop 0.4 —
   * identity-critical detail first (spec §6 priority order).
   */
  weights?: NeedAxisWeights;
  /** Weight of the historical-success term on the total score. Default 0.3. */
  historyWeight?: number;
  /** Coverage satisfied at value >= need * threshold. Default 0.85. */
  coverageThreshold?: number;
  /**
   * Max companion references allowed alongside an approved scene master.
   * Default 1 — a precomposed approved scene master beats stacking many
   * portraits in a two-character dialogue (spec §8).
   */
  maxSceneMasterCompanions?: number;
}

/** One selected reference with its score and the axes it covers. */
export interface SelectedReference {
  assetId: string;
  role: string;
  valueProfile: ReferenceValueProfile;
  score: number;
  axesCovered: NeedAxis[];
}

/** The reference-budget plan for one shot. */
export interface ReferenceBudgetPlan {
  shotId: string;
  strategy: ReferenceStrategy;
  /** Selected assets in provider-passed order. */
  referenceIds: string[];
  /** Detail per selected reference. */
  references: SelectedReference[];
  total: number;
  /** The model's known ceiling; null = unknown. A ceiling, never a target. */
  modelMaxImages: number | null;
  /**
   * True when the selection stayed under the known ceiling (or the model
   * has no ceiling / accepts nothing). False only when the ceiling actually
   * constrained the selection — the honest face of "never stuffed".
   */
  underLimit: boolean;
  /** Aggregated needs this plan satisfied. */
  needs: ShotReferenceNeeds;
  /** Axes with need > 0 still uncovered after selection. */
  uncoveredNeeds: NeedAxis[];
  /** Historical rate per selected asset (null = no history / no oracle). */
  historicalRates: Record<string, number | null>;
  /** Whole-pack historical rate when the oracle supplies one. */
  packHistoricalRate: ReferenceSuccessRate | null;
  /** Deterministic justification log. */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Needs derivation                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_NEEDS: ShotReferenceNeeds = {
  identity: 0.5,
  wardrobe: 0.5,
  location: 0.24,
  prop: 0.15,
  pose: 0.4,
  startState: 0.2,
  endState: 0.2,
};

/**
 * Axes with need below {@link NEED_FLOOR} are "don't care": they never
 * earn a slot and never count as uncovered. This is the mechanical form of
 * MINIMUM SUFFICIENT — a close-up's location flicker (need 0.15) cannot
 * pull in a location reference the way its identity need (1.0) pulls in a
 * face master.
 */
export const NEED_FLOOR = 0.25;

/** Per-shot-type default needs (runbook §17.1 guidance encoded: close-up
 *  1–2 references; medium identity + wardrobe + optional location; two-shot
 *  prefers the scene master). Values below {@link NEED_FLOOR} = don't care. */
const SHOT_TYPE_NEEDS: Record<string, Partial<ShotReferenceNeeds>> = {
  "close-up": { identity: 1.0, pose: 0.4, wardrobe: 0.2, location: 0.1, prop: 0.1, startState: 0.2, endState: 0.1 },
  "medium": { identity: 0.8, wardrobe: 0.7, location: 0.5, startState: 0.3, pose: 0.24, prop: 0.15, endState: 0.2 },
  "medium-close-up": { identity: 0.9, wardrobe: 0.4, pose: 0.4, startState: 0.3, location: 0.2, prop: 0.15, endState: 0.2 },
  "full": { identity: 0.7, wardrobe: 1.0, location: 0.6, pose: 0.2, prop: 0.15, startState: 0.2, endState: 0.2 },
  "full-body": { identity: 0.7, wardrobe: 1.0, location: 0.6, pose: 0.2, prop: 0.15, startState: 0.2, endState: 0.2 },
  "two-shot": { identity: 0.9, wardrobe: 0.6, location: 0.5, startState: 0.3, pose: 0.24, prop: 0.15, endState: 0.2 },
  "dialogue": { identity: 0.9, wardrobe: 0.6, location: 0.5, startState: 0.3, pose: 0.24, prop: 0.15, endState: 0.2 },
  "over-shoulder": { identity: 0.8, wardrobe: 0.5, location: 0.3, startState: 0.3, pose: 0.2, prop: 0.15, endState: 0.15 },
  "over-the-shoulder": { identity: 0.8, wardrobe: 0.5, location: 0.3, startState: 0.3, pose: 0.2, prop: 0.15, endState: 0.15 },
  "establishing": { location: 1.0, identity: 0.1, wardrobe: 0.05, prop: 0.15, pose: 0.05, startState: 0.1, endState: 0.05 },
  "wide": { identity: 0.5, wardrobe: 0.4, location: 0.9, pose: 0.24, prop: 0.2, startState: 0.2, endState: 0.1 },
  "insert": { prop: 1.0, startState: 0.3, identity: 0.0, wardrobe: 0.0, location: 0.1, pose: 0.1, endState: 0.2 },
  "reaction": { identity: 0.7, pose: 0.6, wardrobe: 0.2, location: 0.2, prop: 0.05, startState: 0.2, endState: 0.15 },
};

/**
 * The needs a shot of `shotType` has when the caller supplies no overrides.
 * Unknown shot type falls back to {@link DEFAULT_NEEDS} — never a guess at
 * identity importance beyond the neutral 0.5.
 */
export function needsForShotType(shotType: string): ShotReferenceNeeds {
  const base = SHOT_TYPE_NEEDS[shotType.trim().toLowerCase()] ?? {};
  return { ...DEFAULT_NEEDS, ...base };
}

/* ------------------------------------------------------------------ */
/* History helper                                                      */
/* ------------------------------------------------------------------ */

const NEUTRAL_RATE = 0.5;

function historyRateOrNeutral(rate: number | null | undefined): number {
  return rate ?? NEUTRAL_RATE;
}

/**
 * Historical success rate for one reference across the shot's characters:
 * mean of the per-character non-null rates; null when no character has
 * history (neutral, never 0).
 */
async function combinedReferenceRate(
  oracle: ReferenceHistoryOracle | undefined,
  characters: readonly string[],
  model: string,
  referenceId: string,
): Promise<number | null> {
  if (!oracle || characters.length === 0) return null;
  const rates: number[] = [];
  for (const characterId of characters) {
    const result = await oracle.successRateForReference(
      characterId,
      model,
      referenceId,
    );
    if (result.rate !== null && result.rate !== undefined) rates.push(result.rate);
  }
  if (rates.length === 0) return null;
  return rates.reduce((sum, r) => sum + r, 0) / rates.length;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_WEIGHTS: Record<NeedAxis, number> = {
  identity: 1.0,
  startState: 0.8,
  endState: 0.8,
  wardrobe: 0.6,
  location: 0.5,
  pose: 0.5,
  prop: 0.4,
};

/** Normalize partial weights onto the full axis set (missing = default). */
export function normalizeWeights(
  weights: NeedAxisWeights | undefined,
): Record<NeedAxis, number> {
  return { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
}

function axisValue(profile: ReferenceValueProfile, axis: NeedAxis): number {
  const v = profile[axis];
  return v === undefined ? 0 : v;
}

/** Weighted value of one candidate against one axis's remaining need. */
function axisScore(
  candidate: ReferenceCandidate,
  weights: Record<NeedAxis, number>,
  remaining: Partial<Record<NeedAxis, number>>,
  axis: NeedAxis,
): number {
  return axisValue(candidate.valueProfile, axis) * (weights[axis] ?? 0) * (remaining[axis] ?? 0);
}

/**
 * Weighted score of a candidate against remaining needs, plus the
 * historical-success term (axis 8: rate as score, so a reference that
 * historically succeeds on this model/character wins ties).
 */
export function scoreCandidate(
  candidate: ReferenceCandidate,
  remaining: Partial<Record<NeedAxis, number>>,
  historyRate: number | null,
  options: Pick<ReferenceBudgetOptions, "weights" | "historyWeight"> = {},
): number {
  const weights = normalizeWeights(options.weights);
  const historyWeight = options.historyWeight ?? 0.3;
  let total = 0;
  for (const axis of NEED_AXES) {
    total += axisScore(candidate, weights, remaining, axis);
  }
  const historyScore =
    (historyRateOrNeutral(historyRate) - NEUTRAL_RATE) * historyWeight;
  return total + historyScore;
}

/** Weighted value of a candidate against remaining needs (no history term). */
function valueScore(
  candidate: ReferenceCandidate,
  remaining: Partial<Record<NeedAxis, number>>,
  weights: Record<NeedAxis, number> = DEFAULT_WEIGHTS,
): number {
  let total = 0;
  for (const axis of NEED_AXES) {
    total += axisScore(candidate, weights, remaining, axis);
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Strategy classification                                             */
/* ------------------------------------------------------------------ */

/** Inputs for {@link classifyReferenceStrategy}. */
export interface ReferenceStrategyInput {
  /** Distinct visible characters in the shot. */
  characterCount: number;
  /** An approved scene master exists for the scene. */
  hasApprovedSceneMaster: boolean;
  /** The exact starting composition must be reproduced. */
  exactStartState: boolean;
  /** The exact ending composition must be reproduced. */
  exactEndState: boolean;
  /** Complex scene (props-heavy, 3+ characters, trick shot). */
  complex: boolean;
  /** Derived shot needs (defaults from {@link needsForShotType}). */
  needs: ShotReferenceNeeds;
  /** Model reference capability (CAP-001 `references` block). */
  capability: ReferenceCapability;
}

/** How a classification decision was reached. */
export interface ReferenceStrategyDecision {
  strategy: ReferenceStrategy;
  reasons: string[];
}

/**
 * Deterministic per-shot keyframe/reference strategy classification
 * (spec §8 "mutually exclusive strategies"). Model support is respected:
 * a frame strategy is only chosen when the model supports that input mode;
 * reference-taking strategies only when the model takes references at all
 * (maxImages === 0 means the model accepts none).
 */
export function classifyReferenceStrategy(
  input: ReferenceStrategyInput,
): ReferenceStrategyDecision {
  const reasons: string[] = [];
  const acceptsInputs = input.capability.maxImages !== 0;

  if (input.characterCount === 0 && !input.exactStartState && !input.exactEndState && !input.complex) {
    reasons.push(
      "no visible characters and no exact start/end requirement: text-to-video acceptable",
    );
    return { strategy: "zero-keyframes", reasons };
  }

  const canFirstLast =
    input.capability.firstLastFrame ||
    (input.capability.firstFrame && input.capability.lastFrame);

  if (input.exactStartState && input.exactEndState) {
    if (canFirstLast) {
      reasons.push("exact start and end states with first/last-frame support");
      return { strategy: "start-end-keyframes", reasons };
    }
    if (acceptsInputs) {
      reasons.push(
        "exact start+end required but model has no first/last-frame input: exact end state only expressible as a reference",
      );
      return { strategy: "multimodal-reference-package", reasons };
    }
    reasons.push("exact start+end required but model accepts no inputs: text-to-video only");
    return { strategy: "zero-keyframes", reasons };
  }

  if (input.exactStartState && input.capability.firstFrame) {
    reasons.push("exact start composition with start-frame support");
    return { strategy: "one-starting-keyframe", reasons };
  }

  if (acceptsInputs && input.characterCount >= 2 && input.hasApprovedSceneMaster) {
    reasons.push(
      "multi-character scene with approved scene master: one master beats many portraits",
    );
    return { strategy: "scene-master-plus-references", reasons };
  }

  if (
    acceptsInputs &&
    input.capability.multimodalReferences &&
    (input.complex || input.characterCount >= 3)
  ) {
    reasons.push("complex scene on a model that supports multimodal references");
    return { strategy: "multimodal-reference-package", reasons };
  }

  if (acceptsInputs) {
    const neededAxis = (Object.keys(input.needs) as NeedAxis[]).some(
      (axis) => input.needs[axis] >= 0.5,
    );
    if (neededAxis) {
      reasons.push(
        "identity/wardrobe/location importance present: select allowed references",
      );
      return { strategy: "scene-master-plus-references", reasons };
    }
    reasons.push("low needs overall: zero references sufficient");
    return { strategy: "zero-keyframes", reasons };
  }

  reasons.push("model accepts no reference inputs: text-to-video only");
  return { strategy: "zero-keyframes", reasons };
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/** Input for {@link planReferenceBudget}. */
export interface ReferenceBudgetInput {
  shotId: string;
  shotType: string;
  /** Distinct visible canonical character IDs (historical query keys). */
  characters: readonly string[];
  /**
   * Strategy override from the caller (e.g. the KeyframePlanner's
   * classification). Default: {@link classifyReferenceStrategy}.
   */
  strategy?: ReferenceStrategy;
  /** Per-axis need overrides; absent axes keep the shot-type default. */
  needs?: Partial<Record<NeedAxis, number>>;
  /** Approved-or-not scene master for the shot's scene. */
  sceneMaster?: ReferenceBudgetSceneMaster;
  /** Reference candidates to draw from. */
  candidates: readonly ReferenceCandidate[];
  /** Model reference capability used for ceilings and support flags. */
  capability: ReferenceCapability;
  /** Provider model key for historical-success queries (e.g. "agnes-flash-25"). */
  model: string;
  /** History oracle; absent = neutral historical term. */
  history?: ReferenceHistoryOracle;
  options?: ReferenceBudgetOptions;
}

interface CandidateStats {
  candidate: ReferenceCandidate;
  historyRate: number | null;
  score: number;
}

function coverageValue(selected: ReferenceCandidate[], axis: NeedAxis): number {
  return selected.reduce(
    (max, candidate) => Math.max(max, axisValue(candidate.valueProfile, axis)),
    0,
  );
}

function uncovered(
  selected: ReferenceCandidate[],
  needs: ShotReferenceNeeds,
  threshold: number,
): NeedAxis[] {
  return NEED_AXES.filter((axis) => {
    if (needs[axis] < NEED_FLOOR) return false; // don't-care axis
    return coverageValue(selected, axis) < needs[axis] * threshold;
  });
}

function buildPlan(
  input: ReferenceBudgetInput,
  strategy: ReferenceStrategy,
  selected: ReferenceCandidate[],
  needs: ShotReferenceNeeds,
  statsByAsset: Map<string, CandidateStats>,
  notes: string[],
  options: ReferenceBudgetOptions,
  historicalRates: Record<string, number | null>,
): ReferenceBudgetPlan {
  const uncoveredNeeds = uncovered(
    selected,
    needs,
    options.coverageThreshold ?? 0.85,
  );
  return {
    shotId: input.shotId,
    strategy,
    referenceIds: selected.map((c) => c.assetId),
    total: selected.length,
    modelMaxImages: input.capability.maxImages,
    underLimit: selected.length < (input.capability.maxImages ?? Number.POSITIVE_INFINITY),
    needs,
    uncoveredNeeds,
    historicalRates,
    packHistoricalRate: null,
    references: selected.map((c) => {
      const stats = statsByAsset.get(c.assetId);
      return {
        assetId: c.assetId,
        role: c.kind,
        valueProfile: c.valueProfile,
        score: stats?.score ?? 0,
        axesCovered: NEED_AXES.filter(
          (axis) =>
            needs[axis] >= NEED_FLOOR &&
            axisValue(c.valueProfile, axis) >= needs[axis] * (options.coverageThreshold ?? 0.85),
        ),
      };
    }),
    notes,
  };
}

/**
 * Plan the minimum-sufficient reference set for one shot (spec §8).
 *
 * Selection is coverage-driven: candidates are scored against the REMAINING
 * uncovered needs (weighted, plus the historical-success term), the best
 * candidate is added, covered axes drop out, and selection stops as soon as
 * every needed axis is covered — even when the model's ceiling is far
 * higher. A ceiling is a hard cap and a constraint, never a target.
 */
export async function planReferenceBudget(
  input: ReferenceBudgetInput,
): Promise<ReferenceBudgetPlan> {
  if (!input.shotId.trim()) {
    throw new ReferenceBudgetError("shotId must be non-empty");
  }
  if (input.candidates.length === 0 && input.strategy !== "zero-keyframes") {
    // Empty candidates still produce a plan; notes carry the reason.
  }
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.assetId.trim()) {
      throw new ReferenceBudgetError("candidate assetId must be non-empty");
    }
    if (seen.has(candidate.assetId)) {
      throw new ReferenceBudgetError(`duplicate candidate assetId: ${candidate.assetId}`);
    }
    seen.add(candidate.assetId);
  }

  const needs = { ...needsForShotType(input.shotType), ...(input.needs ?? {}) };
  const options = input.options ?? {};
  const notes: string[] = [];

  const strategy =
    input.strategy ??
    classifyReferenceStrategy({
      characterCount: new Set(input.characters).size,
      hasApprovedSceneMaster: input.sceneMaster?.approved === true,
      // EXACT start/end reproduction is a director-level requirement, not a
      // need strength: only an explicit ~1.0 start/end need (or a frame
      // candidate being present) auto-classifies as a frame strategy.
      exactStartState:
        needs.startState >= 0.9 ||
        input.candidates.some((c) => c.isStartFrame),
      exactEndState:
        needs.endState >= 0.9 ||
        input.candidates.some((c) => c.isEndFrame),
      complex: (input.needs?.identity ?? 0) >= 1 || (input.needs?.prop ?? 0) >= 1,
      needs,
      capability: input.capability,
    }).strategy;

  const maxImages = input.capability.maxImages;
  if (maxImages === 0) {
    notes.push("model accepts no reference inputs: zero references");
    return {
      ...buildPlan(input, strategy, [], needs, new Map(), notes, options, {}),
      underLimit: true,
    };
  }

  // Frame strategies: the frames ARE the minimum sufficient set. Never add
  // extra portraits on top of a precise transition (spec §8).
  if (strategy === "start-end-keyframes" || strategy === "one-starting-keyframe") {
    const needStart = strategy === "start-end-keyframes";
    const wants = needStart ? 2 : 1;
    const canFrames = needStart
      ? input.capability.firstLastFrame ||
        (input.capability.firstFrame && input.capability.lastFrame)
      : input.capability.firstFrame;
    if (!canFrames) {
      notes.push(
        `strategy ${strategy} requested but model does not support the required frame input: zero references`,
      );
      return buildPlan(input, strategy, [], needs, new Map(), notes, options, {});
    }
    const start = input.candidates.find((c) => c.isStartFrame);
    const end = input.candidates.find((c) => c.isEndFrame);
    if (!start) {
      if (input.strategy === undefined) {
        // Auto-classified from a start-frame candidate that then vanished
        // (or an exact-need misfire) — degrade to reference selection
        // instead of failing a plan that could still be minimal-sufficient.
        notes.push(
          `auto-classified ${strategy} but no start-frame candidate present: falling back to reference selection`,
        );
      } else {
        throw new ReferenceBudgetError(
          `strategy ${strategy} requires a start-frame candidate for shot ${input.shotId}`,
        );
      }
    }
    const selected: ReferenceCandidate[] = [];
    if (start) selected.push(start);
    if (needStart && end) selected.push(end);
    if (maxImages !== null && selected.length > maxImages) {
      notes.push(
        `model ceiling ${maxImages} is below the ${wants}-frame strategy: kept ${selected.length} frame(s)`,
      );
      selected.length = maxImages;
    }
    if (selected.length === 0) {
      notes.push("no frame candidates available: zero references");
      return buildPlan(input, strategy, [], needs, new Map(), notes, options, {});
    }
    notes.push(
      `precise ${needStart ? "start+end" : "start"} transition: frames only, no extra references`,
    );
    const historicalRates: Record<string, number | null> = {};
    for (const candidate of selected) {
      historicalRates[candidate.assetId] = await combinedReferenceRate(
        input.history,
        input.characters,
        input.model,
        candidate.assetId,
      );
    }
    const packRate = await packHistory(input, strategy, selected.map((c) => c.assetId));
    const plan = buildPlan(input, strategy, selected, needs, new Map(), notes, options, historicalRates);
    return { ...plan, packHistoricalRate: packRate };
  }

  if (strategy === "zero-keyframes") {
    notes.push("zero keyframes: text-to-video acceptable");
    return buildPlan(input, strategy, [], needs, new Map(), notes, options, {});
  }

  // Selection is capped by the known ceiling (never invent one when null).
  // Per-strategy companion caps keep the pack minimal even when needs are
  // partially covered by a scene master.
  let selected: ReferenceCandidate[] = [];
  const historicalRates: Record<string, number | null> = {};
  const statsByAsset = new Map<string, CandidateStats>();

  if (strategy === "scene-master-plus-references" && input.sceneMaster) {
    if (!input.sceneMaster.approved) {
      notes.push("scene master exists but is not approved: treated as unavailable");
    } else {
      selected.push({
        assetId: input.sceneMaster.assetId,
        kind: "scene-master",
        valueProfile: input.sceneMaster.valueProfile,
      });
      notes.push("approved scene master selected: establishes identities, wardrobe, room, lighting, props, positions");
    }
  }

  const ceiling =
    maxImages !== null
      ? maxImages
      : Number.POSITIVE_INFINITY;

  const companionCap =
    strategy === "scene-master-plus-references" && input.sceneMaster?.approved
      ? (options.maxSceneMasterCompanions ?? 1)
      : Number.POSITIVE_INFINITY;

  let remaining = uncovered(selected, needs, options.coverageThreshold ?? 0.85);
  let rounds = 0;
  while (remaining.length > 0 && selected.length < ceiling) {
    if (rounds++ > 100) break; // defensive; pure coverage loop terminates below
    const remainingNeedsMap = remainingNeeds(remaining, needs);
    const statsForRound: CandidateStats[] = [];
    for (const candidate of input.candidates) {
      if (selected.some((s) => s.assetId === candidate.assetId)) continue;
      // Scene-master assets enter the pack only through the `sceneMaster`
      // input (approval-checked); never auto-select a bare kind
      // "scene-master" candidate here, and never a frame asset outside the
      // frame strategies — a frame is not a "reference".
      if (candidate.kind === "scene-master") continue;
      if (candidate.isStartFrame || candidate.isEndFrame) continue;
      if (
        valueScore(candidate, remainingNeedsMap) <= 0
      ) {
        continue; // no value on any remaining axis: can never help
      }
      const historyRate = await combinedReferenceRate(
        input.history,
        input.characters,
        input.model,
        candidate.assetId,
      );
      const score = scoreCandidate(
        candidate,
        remainingNeedsMap,
        historyRate,
        options,
      );
      statsForRound.push({ candidate, historyRate, score });
    }
    if (statsForRound.length === 0) break;
    statsForRound.sort(
      (a, b) => b.score - a.score || a.candidate.assetId.localeCompare(b.candidate.assetId),
    );
    const best = statsForRound[0];
    if (!best || best.score <= 0) break;
    selected.push(best.candidate);
    historicalRates[best.candidate.assetId] = best.historyRate;
    statsByAsset.set(best.candidate.assetId, best);
    remaining = uncovered(selected, needs, options.coverageThreshold ?? 0.85);
    if (strategy === "scene-master-plus-references" && input.sceneMaster?.approved) {
      const companions = selected.length - 1;
      if (companions >= companionCap) {
        remaining = [];
      }
    }
  }

  if (remaining.length === 0) {
    notes.push("all needed axes covered: selection stopped, remaining model slots unused");
  } else if (selected.length >= ceiling) {
    notes.push(`model ceiling ${maxImages} constrained selection; uncovered: ${remaining.join(", ")}`);
  } else {
    notes.push(`no candidate covers remaining axes: ${remaining.join(", ")}`);
  }

  const packRate = await packHistory(input, strategy, selected.map((c) => c.assetId));
  const plan = buildPlan(input, strategy, selected, needs, statsByAsset, notes, options, historicalRates);
  return { ...plan, packHistoricalRate: packRate };
}

function remainingNeeds(
  remainingAxes: readonly NeedAxis[],
  needs: ShotReferenceNeeds,
): Partial<Record<NeedAxis, number>> {
  const out: Partial<Record<NeedAxis, number>> = {};
  for (const axis of remainingAxes) out[axis] = needs[axis];
  return out;
}

async function packHistory(
  input: ReferenceBudgetInput,
  strategy: ReferenceStrategy,
  referenceIds: readonly string[],
): Promise<ReferenceSuccessRate | null> {
  if (!input.history?.successRateForPack) return null;
  if (referenceIds.length === 0) return null;
  if (strategy === "zero-keyframes") return null;
  const characterId = input.characters[0];
  if (!characterId) return null;
  try {
    return await input.history.successRateForPack(characterId, input.model, referenceIds);
  } catch {
    return null;
  }
}
