import {
  DEFAULT_REVISION_LOOP_CONFIG,
  MAX_REVISION_ITERATIONS,
  SEVERITY_RANK,
  CRITIC_SCHEMA_VERSION,
  type CriticFinding,
  type CriticReport,
  type RevisionIteration,
  type RevisionLoopConfig,
  type RevisionLoopInput,
  type RevisionLoopResult,
  type RevisionScreenplayLike,
  type RevisionStopReason,
} from "./types.js";

export class RevisionLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionLoopError";
  }
}

/** Normalize a user-supplied config against defaults; throws on invalid values. */
export function resolveRevisionLoopConfig(
  config?: Partial<RevisionLoopConfig>,
): RevisionLoopConfig {
  const maxIterations = config?.maxIterations ?? DEFAULT_REVISION_LOOP_CONFIG.maxIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    throw new RevisionLoopError(
      `maxIterations must be an integer >= 0, received ${String(maxIterations)}`,
    );
  }
  if (maxIterations > MAX_REVISION_ITERATIONS) {
    throw new RevisionLoopError(
      `maxIterations must be <= ${MAX_REVISION_ITERATIONS}, received ${String(maxIterations)}`,
    );
  }
  const actionableAtSeverity =
    config?.actionableAtSeverity ?? DEFAULT_REVISION_LOOP_CONFIG.actionableAtSeverity;
  if (!(actionableAtSeverity in SEVERITY_RANK)) {
    throw new RevisionLoopError(
      `actionableAtSeverity must be one of ${Object.keys(SEVERITY_RANK).join(", ")}`,
    );
  }
  return { maxIterations, actionableAtSeverity };
}

/** True when a finding is at or above the configured actionable threshold. */
export function isActionable(
  finding: CriticFinding,
  threshold: RevisionLoopConfig["actionableAtSeverity"],
): boolean {
  const rank = SEVERITY_RANK[finding.severity] ?? 0;
  return rank >= SEVERITY_RANK[threshold];
}

/**
 * Scene ids affected by the actionable findings. Findings without a target
 * scene are screenplay-global: every scene is considered affected so a
 * targeted reviser can still see the whole doc as its scope.
 */
export function affectedSceneIds(
  screenplay: RevisionScreenplayLike,
  findings: readonly CriticFinding[],
): string[] {
  const global = findings.some((f) => f.target?.sceneId === undefined);
  const targeted = new Set<string>();
  for (const f of findings) {
    const id = f.target?.sceneId;
    if (id !== undefined) targeted.add(id);
  }
  if (global || targeted.size === 0) {
    return screenplay.scenes.map((s) => s.sceneId);
  }
  // Emit each scene at most once, in screenplay order; ids the critic named
  // that do not exist in the screenplay are dropped.
  return screenplay.scenes
    .map((s) => s.sceneId)
    .filter((id, index, all) => targeted.has(id) && all.indexOf(id) === index);
}

/**
 * Stable, order-insensitive signature of the actionable finding set, used to
 * detect a stalled loop (writer keeps producing the same findings).
 * Unrecognized severities are treated as non-actionable and excluded, so a
 * schema-drifted finding cannot accidentally count as progress.
 */
export function actionableSignature(findings: readonly CriticFinding[]): string {
  const actionable = [...findings].filter(
    (f) => SEVERITY_RANK[f.severity] !== undefined,
  );
  return JSON.stringify(
    actionable
      .map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        summary: f.summary,
        scene: f.target?.sceneId,
      }))
      .sort((a, b) => {
        const ai = String(a.id);
        const bi = String(b.id);
        if (ai !== bi) return ai < bi ? -1 : 1;
        const as = String(a.summary ?? "");
        const bs = String(b.summary ?? "");
        return as < bs ? -1 : as > bs ? 1 : 0;
      }),
  );
}

function validateReport(report: CriticReport, iteration: number): void {
  if (report.schemaVersion !== CRITIC_SCHEMA_VERSION) {
    throw new RevisionLoopError(
      `critic returned schemaVersion ${String(report.schemaVersion)} at iteration ${iteration}; expected ${CRITIC_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(report.findings)) {
    throw new RevisionLoopError(`critic returned non-array findings at iteration ${iteration}`);
  }
  for (const f of report.findings) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) {
      throw new RevisionLoopError(
        `critic returned a non-object finding at iteration ${iteration}`,
      );
    }
  }
}

/**
 * DIR-007 script revision loop: critic findings → targeted revision →
 * re-criticize, bounded by `maxIterations` reviser calls.
 *
 * Flow per iteration:
 *  1. critic evaluates the current screenplay;
 *  2. findings below `actionableAtSeverity` are recorded but not acted on;
 *  3. no actionable findings → stop `converged`;
 *  4. actionable findings identical to the previous pass → stop `no_progress`
 *     (the reviser is not making progress; continuing would burn iterations);
 *  5. otherwise pass the actionable findings to the reviser with the affected
 *     scene scope and loop, until `maxIterations` reviser calls are used;
 *  6. bound reached without convergence → stop `max_iterations`.
 *
 * The loop never mutates its input screenplay; the reviser returns the new
 * complete value. The screenplay value is opaque data carried between the
 * critic and reviser — story text is untrusted and never interpreted.
 */
export async function runRevisionLoop<TScreenplay extends RevisionScreenplayLike>(
  input: RevisionLoopInput<TScreenplay>,
): Promise<RevisionLoopResult<TScreenplay>> {
  const config = resolveRevisionLoopConfig(input.config);
  const { critic, reviser, screenplay: initial } = input;

  const iterations: RevisionIteration[] = [];
  let current: TScreenplay = initial;
  let previousSignature: string | undefined;
  let iterationsUsed = 0;

  for (let iteration = 1; iteration <= config.maxIterations + 1; iteration++) {
    const report = await critic.criticize(current, {
      iteration,
      revisedScenes:
        iteration === 1 ? [] : iterations[iterations.length - 1]?.affectedScenes ?? [],
      ...(input.context?.sceneIdLookup === undefined
        ? {}
        : { sceneIdLookup: input.context.sceneIdLookup }),
    });
    validateReport(report, iteration);

    const actionable = report.findings.filter((f) => isActionable(f, config.actionableAtSeverity));
    const sceneIds = affectedSceneIds(current, actionable);

    const signature = actionableSignature(actionable);

    // Convergence: nothing actionable remains.
    if (actionable.length === 0) {
      iterations.push({
        index: iteration,
        findingsCount: report.findings.length,
        actionableCount: 0,
        affectedScenes: [],
        findingIds: [],
        revised: false,
      });
      return {
        screenplay: current,
        converged: true,
        stopReason: "converged",
        iterationsUsed,
        maxIterations: config.maxIterations,
        iterations,
        finalFindings: report.findings,
      };
    }

    // Stalled: same actionable set as the previous pass → no progress.
    if (previousSignature !== undefined && signature === previousSignature) {
      iterations.push({
        index: iteration,
        findingsCount: report.findings.length,
        actionableCount: actionable.length,
        affectedScenes: [],
        findingIds: actionable.map((f) => f.id),
        revised: false,
      });
      return {
        screenplay: current,
        converged: false,
        stopReason: "no_progress",
        iterationsUsed,
        maxIterations: config.maxIterations,
        iterations,
        finalFindings: report.findings,
      };
    }
    previousSignature = signature;

    // Bound: the final critic pass after the last allowed revision.
    if (iteration > config.maxIterations) {
      iterations.push({
        index: iteration,
        findingsCount: report.findings.length,
        actionableCount: actionable.length,
        affectedScenes: [],
        findingIds: actionable.map((f) => f.id),
        revised: false,
      });
      return {
        screenplay: current,
        converged: false,
        stopReason: "max_iterations",
        iterationsUsed,
        maxIterations: config.maxIterations,
        iterations,
        finalFindings: report.findings,
      };
    }

    // Targeted revision pass.
    const next = await reviser.revise({
      screenplay: current,
      findings: actionable,
      affectedScenes: sceneIds,
      iteration,
    });
    if (next === undefined || next === null) {
      throw new RevisionLoopError(`reviser returned ${String(next)} at iteration ${iteration}`);
    }
    iterations.push({
      index: iteration,
      findingsCount: report.findings.length,
      actionableCount: actionable.length,
      affectedScenes: sceneIds,
      findingIds: actionable.map((f) => f.id),
      revised: true,
    });
    current = next;
    iterationsUsed = iteration;
  }

  // Unreachable: every path above returns. Guard for type exhaustiveness.
  throw new RevisionLoopError("revision loop exited without a stop reason");
}