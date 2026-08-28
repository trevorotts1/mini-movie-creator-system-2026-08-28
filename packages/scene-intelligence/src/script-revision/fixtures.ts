import type { CriticFinding, CriticReport, RevisionScreenplayLike } from "./types.js";

/**
 * DIR-007 test fixtures — deterministic critic/reviser stubs and a small
 * screenplay fixture. These are plain data used only by tests and as adapter
 * examples; no network, no LLM.
 */

export interface FixtureScreenplay extends RevisionScreenplayLike {
  title: string;
  scenes: Array<{ sceneId: string; heading: string; action: string; dialogue: string[] }>;
}

export const FIXTURE_SCREENPLAY: FixtureScreenplay = {
  title: "The Vault",
  scenes: [
    {
      sceneId: "SC-01",
      heading: "INT. VAULT LOBBY - NIGHT",
      action: "Monica badges through the lobby door.",
      dialogue: ["MONICA: Stay close.", "MARCUS: I always do."],
    },
    {
      sceneId: "SC-02",
      heading: "INT. VAULT CORRIDOR - NIGHT",
      action: "Marcus checks the corridor. Monica hesitates.",
      dialogue: ["MONICA: Two minutes.", "MARCUS: Two minutes."],
    },
  ],
};

/** Scripted critic: returns a canned report per call, in order. */
export class ScriptedCritic {
  readonly calls: Array<{ screenplay: FixtureScreenplay; iteration: number; revisedScenes: readonly string[] }> = [];
  constructor(private readonly reports: Array<CriticReport | "converged">) {}

  criticize(
    screenplay: FixtureScreenplay,
    context: { iteration: number; revisedScenes: readonly string[] },
  ): CriticReport {
    this.calls.push({
      screenplay: JSON.parse(JSON.stringify(screenplay)) as FixtureScreenplay,
      iteration: context.iteration,
      revisedScenes: [...context.revisedScenes],
    });
    const entry = this.reports[Math.min(context.iteration - 1, this.reports.length - 1)];
    if (entry === undefined) throw new Error("ScriptedCritic ran out of reports");
    if (entry === "converged") return { schemaVersion: 1, findings: [], criticId: "scripted" };
    return entry;
  }
}

/** Recording reviser: applies a fixed mutation per call and records requests. */
export class RecordingReviser {
  readonly requests: Array<{
    affectedScenes: readonly string[];
    findings: readonly CriticFinding[];
    iteration: number;
  }> = [];
  constructor(private readonly mutate?: (s: FixtureScreenplay, iteration: number) => FixtureScreenplay) {}

  revise(request: {
    screenplay: FixtureScreenplay;
    findings: readonly CriticFinding[];
    affectedScenes: readonly string[];
    iteration: number;
  }): FixtureScreenplay {
    this.requests.push({
      affectedScenes: [...request.affectedScenes],
      findings: request.findings,
      iteration: request.iteration,
    });
    if (!this.mutate) return request.screenplay;
    return this.mutate(JSON.parse(JSON.stringify(request.screenplay)) as FixtureScreenplay, request.iteration);
  }
}

/** Deterministic finding builders used across the tests. */
export function finding(
  id: string,
  severity: CriticFinding["severity"] = "major",
  sceneId?: string,
  category: CriticFinding["category"] = "pacing",
): CriticFinding {
  return {
    schemaVersion: 1,
    id,
    category,
    severity,
    summary: `finding ${id}`,
    ...(sceneId === undefined ? {} : { target: { sceneId } }),
  };
}

/** Mutation that tags a revised marker into targeted scene actions. */
export function tagRevisedScenes(
  s: FixtureScreenplay,
  iteration: number,
): FixtureScreenplay {
  return {
    ...s,
    scenes: s.scenes.map((scene) => ({
      ...scene,
      action: `${scene.action} [rev${iteration}]`,
    })),
  };
}