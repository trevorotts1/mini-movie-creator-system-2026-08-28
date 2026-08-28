/**
 * DIR-007 — Script revision loop types.
 *
 * Contract: critic findings → targeted revision → re-criticize, bounded by a
 * configurable maximum number of revision iterations. The loop is generic over
 * the screenplay representation so DIR-004's concrete screenplay type can be
 * plugged in via structural typing without coupling this module to it
 * (DIR-004's `ScreenplayScene` carries `sceneId`, which satisfies
 * `RevisionScreenplayLike`).
 *
 * Story/script text is untrusted data: it is only ever carried as opaque
 * values through these structures — never parsed as instructions, shell, or
 * code (runbook §47).
 */

/** Version of the finding/report schema exchanged with the critic. */
export const CRITIC_SCHEMA_VERSION = 1 as const;

/**
 * Finding categories. The union is a superset of the DIR-006 script critic
 * vocab (which uses `"character-consistency"` with a hyphen); DIR-007's own
 * alias `"character_consistency"` and the extra buckets are kept so both
 * spellings typecheck and the loop never rejects a critic adapter's output.
 */
export type CriticFindingCategory =
  | "pacing"
  | "continuity"
  | "dialogue"
  | "character-consistency"
  | "character_consistency"
  | "structure"
  | "other";

/**
 * Severity ranking; higher is more severe. Superset of the DIR-006 ladder
 * (`info|minor|major|critical`); `blocker` is kept as an alias of `critical`
 * for DIR-007's own callers.
 */
export type CriticFindingSeverity = "info" | "minor" | "major" | "critical" | "blocker";

export const SEVERITY_RANK: Readonly<Record<CriticFindingSeverity, number>> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
  blocker: 3,
};

/**
 * One structured critic finding. `id` must be stable within a critic run so
 * the loop can detect a stalled revision (identical finding set twice in a
 * row means the writer is not making progress).
 *
 * The DIR-006 script critic emits this shape directly except for the scene
 * target: DIR-006 anchors a finding with a 1-based `sceneIndex` (null when
 * screenplay-global) inside `location`, not a scene id. Keep that detail out
 * of this base contract and normalize through `CriticContext.sceneIdLookup`
 * instead — the loop only needs to know WHICH scene id a finding touches, and
 * the adapter that owns the concrete screenplay supplies the id for an index.
 */
export interface CriticFinding {
  schemaVersion: typeof CRITIC_SCHEMA_VERSION;
  id: string;
  category: CriticFindingCategory;
  severity: CriticFindingSeverity;
  /** Human-readable one-line summary of the problem. */
  summary: string;
  /** Optional longer explanation from the critic. */
  detail?: string;
  /** Optional concrete suggested change. */
  suggestion?: string;
  /** Scene id the finding applies to (undefined = screenplay-global). */
  target?: { sceneId?: string };
}

/** A critic report is a versioned envelope around a list of findings. */
export interface CriticReport<TFinding extends CriticFinding = CriticFinding> {
  schemaVersion: typeof CRITIC_SCHEMA_VERSION;
  findings: TFinding[];
  /** Which critic model/config produced this report (provenance, optional). */
  criticId?: string;
}

/**
 * Minimal structural shape the loop requires of a screenplay value. The
 * screenplay is opaque data: the loop never reads or interprets text fields.
 * DIR-004's concrete `Screenplay` satisfies this contract because its
 * `ScreenplayScene` carries a `sceneId` (targeting uses that id).
 */
export interface RevisionScreenplayLike {
  /** Scenes keyed by stable id; targeting is expressed in these ids. */
  scenes: ReadonlyArray<{ sceneId: string }>;
}

/** What the critic receives. Kept open so real critic adapters can extend. */
export interface CriticContext {
  /** 1-based iteration about to be judged (first pass is 1). */
  iteration: number;
  /** Scene ids the previous revision touched (empty on the first pass). */
  revisedScenes: readonly string[];
  /**
   * Maps a 1-based scene index to its scene id, so adapters wrapping a
   * DIR-006-style critic (findings anchored by `sceneIndex`, not scene id)
   * can translate to the loop's scene-id targeting. Undefined entries and
   * out-of-range indexes mean "no scene" (screenplay-global finding).
   */
  sceneIdLookup?: (sceneIndex: number) => string | undefined;
}

/**
 * The critic interface DIR-007 consumes. Any adapter (stub, DIR-006 critic,
 * LLM-backed critic) conforms by returning a versioned CriticReport.
 */
export interface ScriptCritic<TScreenplay> {
  criticize(
    screenplay: TScreenplay,
    context: CriticContext,
  ): CriticReport | Promise<CriticReport>;
}

/** What the reviser receives for one revision pass. */
export interface RevisionRequest<TScreenplay> {
  /** Current screenplay (input of this pass). */
  screenplay: TScreenplay;
  /** Only the actionable findings for this pass, as returned by the critic. */
  findings: readonly CriticFinding[];
  /** Scene ids considered affected (findings' targets; global ⇒ all scenes). */
  affectedScenes: readonly string[];
  /** 1-based revision pass number. */
  iteration: number;
}

/**
 * The writer interface DIR-007 consumes. Contract: a *targeted* reviser
 * changes only scenes listed in `affectedScenes` and returns the complete
 * new screenplay value (the loop never mutates its input).
 */
export interface ScriptReviser<TScreenplay> {
  revise(request: RevisionRequest<TScreenplay>):
    | TScreenplay
    | Promise<TScreenplay>;
}

/** Why the loop stopped. */
export type RevisionStopReason =
  /** Critic returned no actionable findings. */
  | "converged"
  /** maxIterations revision passes were used without convergence. */
  | "max_iterations"
  /** Two consecutive critic passes returned the same actionable finding set. */
  | "no_progress";

/** One recorded iteration of the loop (for auditability/resumability). */
export interface RevisionIteration {
  /** 1-based iteration index. */
  index: number;
  /** Raw finding count the critic returned this pass. */
  findingsCount: number;
  /** Findings at or above the actionable severity threshold. */
  actionableCount: number;
  /** Scene ids targeted by the revision pass (empty when none ran). */
  affectedScenes: string[];
  /** Ids of the actionable findings this pass. */
  findingIds: string[];
  /** Whether a revision pass ran for this iteration. */
  revised: boolean;
}

export interface RevisionLoopConfig {
  /**
   * Maximum number of revision (criticize → revise) passes. The loop never
   * runs more than this many reviser calls. Default 3. Must be an integer >= 0.
   */
  maxIterations: number;
  /**
   * Minimum severity the loop treats as actionable. Findings below it are
   * recorded but never trigger a revision. Default "minor" (address
   * everything); set to "major" or "blocker" to ignore lesser findings.
   */
  actionableAtSeverity: CriticFindingSeverity;
}

export const DEFAULT_REVISION_LOOP_CONFIG: Readonly<RevisionLoopConfig> = {
  maxIterations: 3,
  actionableAtSeverity: "minor",
};

/**
 * Hard ceiling on `maxIterations`. Every iteration costs a paid critic and
 * reviser call, and floating-point integers beyond ~1e300 are effectively
 * unbounded retries — so config validation rejects anything above this.
 */
export const MAX_REVISION_ITERATIONS = 100;

export interface RevisionLoopInput<TScreenplay> {
  screenplay: TScreenplay;
  critic: ScriptCritic<TScreenplay>;
  reviser: ScriptReviser<TScreenplay>;
  config?: Partial<RevisionLoopConfig>;
  /**
   * Per-run critic context extensions. Only `sceneIdLookup` is consumed by the
   * loop itself and forwarded to the critic (see CriticContext); additional
   * keys are accepted here so a run can carry its own reviewer state without
   * widening the core types, but the loop does not forward them.
   */
  context?: Partial<Omit<CriticContext, "iteration" | "revisedScenes">>;
}

export interface RevisionLoopResult<TScreenplay> {
  /** Final screenplay value (original when no revision ran). */
  screenplay: TScreenplay;
  /** True when the critic ended with no actionable findings. */
  converged: boolean;
  stopReason: RevisionStopReason;
  /** Revision passes actually used (0 when the first pass was clean). */
  iterationsUsed: number;
  /** The configured/validated bound. */
  maxIterations: number;
  /** Per-iteration audit trail. */
  iterations: readonly RevisionIteration[];
  /** Findings from the final critic pass (actionable and below-threshold). */
  finalFindings: readonly CriticFinding[];
}