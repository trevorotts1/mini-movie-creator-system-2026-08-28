/**
 * Runtime estimator input contract (spec §7 — "estimate scene duration";
 * spec §24 `mmcs estimate`). The upstream screenplay generator (DIR-004)
 * owns screenplay authorship; this module owns the structural shape the
 * estimator reads. Structural, versioned, and tolerant: any producer whose
 * scenes/dialogue/action conform to this shape plugs in without a rewrite.
 *
 * Story text is UNTRUSTED DATA (spec §29): it is only word-counted here —
 * never evaluated, executed, or interpreted as instructions.
 */

/** Estimator input schema version. Bump on any breaking shape change. */
export const RUNTIME_ESTIMATOR_INPUT_VERSION = 1;

/** Kinds of screenplay element the estimator distinguishes. */
export const SCREENPLAY_ELEMENT_KINDS = ["dialogue", "action"] as const;

export type ScreenplayElementKind = (typeof SCREENPLAY_ELEMENT_KINDS)[number];

/** One screenplay element: a spoken line or a block of action/description. */
export interface ScreenplayElement {
  /** `"dialogue"` = spoken line (paced at speech rate); `"action"` = description (paced faster). */
  readonly kind: ScreenplayElementKind;
  /** Verbatim element text. Counted, never executed. */
  readonly text: string;
  /** Speaking character name (dialogue only; informational for estimates). */
  readonly character?: string;
}

/** One narrative scene as the estimator reads it. */
export interface ScreenplaySceneInput {
  /** Stable scene identifier (e.g. `"SC01"`). Required — per-scene estimates key on it. */
  readonly id: string;
  /** Optional scene heading/title, persisted with the estimate for reporting. */
  readonly title?: string;
  /** Elements in script order. */
  readonly elements: readonly ScreenplayElement[];
}

/** A structured screenplay: the estimator's input unit. */
export interface ScreenplayInput {
  /** Stable screenplay identifier (e.g. episode/project scoped). */
  readonly id: string;
  /** Optional display title. */
  readonly title?: string;
  /** Scenes in script order. */
  readonly scenes: readonly ScreenplaySceneInput[];
}

/** Tunable pacing parameters. Every value must be finite and positive. */
export interface RuntimeEstimatorOptions {
  /** Spoken words per second of screen time. Default `DIALOGUE_WORDS_PER_SECOND`. */
  readonly dialogueWordsPerSecond?: number;
  /** Action/description words per second of screen time. Default `ACTION_WORDS_PER_SECOND`. */
  readonly actionWordsPerSecond?: number;
  /** Fixed seconds added per scene (cut/establishing/transition overhead). */
  readonly sceneOverheadSeconds?: number;
  /** Lower bound for any single scene's estimate, in seconds. */
  readonly minSceneSeconds?: number;
}

/** Resolved (all-fields-present) estimator options. */
export interface ResolvedRuntimeEstimatorOptions {
  readonly dialogueWordsPerSecond: number;
  readonly actionWordsPerSecond: number;
  readonly sceneOverheadSeconds: number;
  readonly minSceneSeconds: number;
}

/** Per-scene estimate breakdown. */
export interface SceneEstimate {
  /** Position of the scene in the screenplay, 0-based. */
  readonly sceneIndex: number;
  /** Scene identifier from the input. */
  readonly sceneId: string;
  /** Scene title from the input (or the scene id when absent). */
  readonly sceneTitle: string;
  /** Counted spoken words in the scene. */
  readonly dialogueWords: number;
  /** Counted action/description words in the scene. */
  readonly actionWords: number;
  /** Screen seconds attributed to dialogue. */
  readonly dialogueSeconds: number;
  /** Screen seconds attributed to action/description. */
  readonly actionSeconds: number;
  /** Fixed per-scene overhead seconds applied. */
  readonly overheadSeconds: number;
  /** Final scene estimate in seconds (after the minimum-scene clamp). */
  readonly estimatedSeconds: number;
}

/** Full runtime estimate for one screenplay — the persisted record shape. */
export interface RuntimeEstimate {
  /** Screenplay identifier from the input. */
  readonly screenplayId: string;
  /** Screenplay title from the input (or the id when absent). */
  readonly screenplayTitle: string;
  /** Sum of all per-scene estimates, in seconds. */
  readonly totalSeconds: number;
  /** Per-scene breakdown, in script order. */
  readonly perScene: readonly SceneEstimate[];
  /** Estimator version that produced this estimate. */
  readonly estimatorVersion: string;
  /** Input schema version the estimate was computed against. */
  readonly inputVersion: number;
  /** Resolved options actually used (defaults filled in). */
  readonly options: ResolvedRuntimeEstimatorOptions;
  /** ISO-8601 timestamp when the estimate was computed. */
  readonly estimatedAt: string;
}

/** Thrown for structurally invalid input or options. */
export class RuntimeEstimatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEstimatorError";
  }
}