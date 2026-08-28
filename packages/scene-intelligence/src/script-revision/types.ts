/**
 * DIR-007 — Script revision loop types.
 *
 * Contract: critic findings → targeted revision → re-criticize, bounded by a
 * configurable maximum number of revision iterations. The loop is generic over
 * the screenplay representation so DIR-004's concrete screenplay type can be
 * plugged in via structural typing without coupling this module to it.
 *
 * Story/script text is untrusted data: it is only ever carried as opaque
 * values through these structures — never parsed as instructions, shell, or
 * code (runbook §47).
 */

/** Version of the finding/report schema exchanged with the critic. */
export const CRITIC_SCHEMA_VERSION = 1 as const;

/** Finding categories mirror the DIR-006 script critic dimensions. */
export type CriticFindingCategory =
  | "pacing"
  | "continuity"
  | "dialogue"
  | "character_consistency"
  | "structure"
  | "other";

/** Severity ranking; higher is more severe. */
export type CriticFindingSeverity = "minor" | "major" | "blocker";

export const SEVERITY_RANK: Readonly<Record<CriticFindingSeverity, number>> = {
  minor: 1,
  major: 2,
  blocker: 3,
};

/**
 * One structured critic finding. `id` must be stable within a critic run so
 * the loop can detect a stalled revision (identical finding set twice in a
 * row means the writer is not making progress).
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
  /**
   * Scene the finding applies to. Findings without a scene target are treated
   * as screenplay-global (affect every scene for targeting purposes).
   */
  target?: { sceneId?: string };
}

/** A critic report is a versioned envelope around a list of findings. */
export interface CriticReport<TFinding extends CriticFinding = CriticFinding> {
  schemaVersion: typeof CRITIC_SCHEMA_VERSION;
  findings: TFinding[];
  /** Which critic model/config produced this report (provenance, optional). */
  criticId?: string;
}

/** Minimal structural shape the loop requires of a screenplay value. */
export interface RevisionScreenplayLike {
  /** Scenes keyed by stable id; targeting is expressed in these ids. */
  scenes: ReadonlyArray<{ id: string } & Record<string, unknown>>;
}

/** What the critic receives. Kept open so real critic adapters can extend. */
export interface CriticContext {
  /** 1-based iteration about to be judged (first pass is 1). */
  iteration: number;
  /** Scene ids the previous revision touched (empty on the first pass). */
  revisedScenes: readonly string[];
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

export interface RevisionLoopInput<TScreenplay> {
  screenplay: TScreenplay;
  critic: ScriptCritic<TScreenplay>;
  reviser: ScriptReviser<TScreenplay>;
  config?: Partial<RevisionLoopConfig>;
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