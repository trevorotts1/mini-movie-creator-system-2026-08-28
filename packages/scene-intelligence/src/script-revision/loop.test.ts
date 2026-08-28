import { describe, expect, it } from "vitest";
import { DEFAULT_REVISION_LOOP_CONFIG, CRITIC_SCHEMA_VERSION } from "./types.js";
import {
  actionableSignature,
  affectedSceneIds,
  isActionable,
  resolveRevisionLoopConfig,
  RevisionLoopError,
  runRevisionLoop,
} from "./loop.js";
import {
  FIXTURE_SCREENPLAY,
  finding,
  RecordingReviser,
  ScriptedCritic,
  tagRevisedScenes,
  type FixtureScreenplay,
} from "./fixtures.js";
import type { CriticContext, CriticFinding, ScriptCritic } from "./types.js";

function report(findings: Array<ReturnType<typeof finding>>, criticId = "test-critic") {
  return { schemaVersion: CRITIC_SCHEMA_VERSION, findings, criticId };
}

describe("config resolution (DIR-007)", () => {
  it("applies documented defaults", () => {
    expect(DEFAULT_REVISION_LOOP_CONFIG.maxIterations).toBe(3);
    expect(DEFAULT_REVISION_LOOP_CONFIG.actionableAtSeverity).toBe("minor");
    expect(resolveRevisionLoopConfig(undefined)).toEqual({
      maxIterations: 3,
      actionableAtSeverity: "minor",
    });
  });

  it("accepts explicit overrides", () => {
    expect(
      resolveRevisionLoopConfig({ maxIterations: 5, actionableAtSeverity: "blocker" }),
    ).toEqual({ maxIterations: 5, actionableAtSeverity: "blocker" });
  });

  it("rejects non-integer / negative maxIterations", () => {
    expect(() => resolveRevisionLoopConfig({ maxIterations: -1 })).toThrow(RevisionLoopError);
    expect(() => resolveRevisionLoopConfig({ maxIterations: 1.5 })).toThrow(RevisionLoopError);
  });

  it("rejects maxIterations above the hard ceiling (unbounded-retry guard)", () => {
    expect(() => resolveRevisionLoopConfig({ maxIterations: 101 })).toThrow(RevisionLoopError);
    expect(() => resolveRevisionLoopConfig({ maxIterations: 1e300 })).toThrow(
      RevisionLoopError,
    );
    expect(resolveRevisionLoopConfig({ maxIterations: 100 }).maxIterations).toBe(100);
  });

  it("rejects unknown severity thresholds", () => {
    expect(() =>
      resolveRevisionLoopConfig({ actionableAtSeverity: "catastrophic" as never }),
    ).toThrow(RevisionLoopError);
  });

  it("allows zero iterations (critic-only pass)", () => {
    expect(resolveRevisionLoopConfig({ maxIterations: 0 }).maxIterations).toBe(0);
  });
});

describe("severity/actionability helpers (DIR-007)", () => {
  it("ranks severities and applies the threshold", () => {
    expect(isActionable(finding("a", "minor"), "minor")).toBe(true);
    expect(isActionable(finding("a", "minor"), "major")).toBe(false);
    expect(isActionable(finding("a", "blocker"), "major")).toBe(true);
  });

  it("targets affected scenes; global findings affect all scenes", () => {
    const screenplay = { scenes: [{ sceneId: "SC-01" }, { sceneId: "SC-02" }, { sceneId: "SC-03" }] };
    expect(
      affectedSceneIds(screenplay, [finding("f1", "major", "SC-02"), finding("f2", "major", "SC-03")]),
    ).toEqual(["SC-02", "SC-03"]);
    expect(affectedSceneIds(screenplay, [finding("f1", "major")])).toEqual([
      "SC-01",
      "SC-02",
      "SC-03",
    ]);
  });

  it("deduplicates scenes named by multiple findings and drops unknown ids", () => {
    const screenplay = { scenes: [{ sceneId: "SC-01" }, { sceneId: "SC-02" }] };
    expect(
      affectedSceneIds(screenplay, [
        finding("f1", "major", "SC-02"),
        finding("f2", "major", "SC-02"),
      ]),
    ).toEqual(["SC-02"]);
    // Critic names a scene id that does not exist: dropped, not invented.
    expect(
      affectedSceneIds(screenplay, [finding("f1", "major", "SC-GHOST")]),
    ).toEqual([]);
  });
});

describe("DIR-006 critic interop (regression)", () => {
  // The DIR-006 script critic is this loop's upstream (task-graph DIR-007 ←
  // DIR-006). Its real vocab is: categories with hyphen spelling
  // ("character-consistency"), severities info|minor|major|critical. The loop
  // must accept those shapes unchanged — no adapter rewriting required.
  it("accepts DIR-006 finding shapes (hyphen category, critical severity)", async () => {
    const dir006Finding = (n: number): CriticFinding => ({
      schemaVersion: CRITIC_SCHEMA_VERSION,
      id: `CON-${n}`,
      category: "character-consistency",
      severity: "critical",
      summary: `continuity break ${n}`,
    });
    const critic = new ScriptedCritic([report([dir006Finding(1)]), "converged"]);
    const reviser = new RecordingReviser(tagRevisedScenes);
    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 2 },
    });
    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(reviser.requests).toHaveLength(1);
    expect(reviser.requests[0]?.findings[0]?.category).toBe("character-consistency");
    expect(reviser.requests[0]?.findings[0]?.severity).toBe("critical");
  });

  it("ranks DIR-006 severities against the actionable threshold", () => {
    const f = (severity: CriticFinding["severity"]): CriticFinding => ({
      schemaVersion: CRITIC_SCHEMA_VERSION,
      id: "x",
      category: "pacing",
      severity,
      summary: "s",
    });
    expect(isActionable(f("critical"), "major")).toBe(true);
    expect(isActionable(f("critical"), "blocker")).toBe(true); // alias rank
    expect(isActionable(f("major"), "critical")).toBe(false);
    expect(isActionable(f("info"), "minor")).toBe(false);
    expect(isActionable(f("info"), "info")).toBe(true);
  });

  it("targets findings anchored by DIR-006 sceneIndex via sceneIdLookup", async () => {
    // DIR-006 anchors findings by 1-based sceneIndex, not scene id. The
    // context lookup translates index → sceneId before targeting.
    const dir006Finding = (sceneIndex: number): CriticFinding => ({
      schemaVersion: CRITIC_SCHEMA_VERSION,
      id: `F-idx-${sceneIndex}`,
      category: "dialogue",
      severity: "major",
      summary: `scene ${sceneIndex}`,
      target: { sceneId: undefined },
    });
    const screenplay = {
      scenes: [
        { sceneId: "SC-01", heading: "", action: "", dialogue: [] as string[] },
        { sceneId: "SC-02", heading: "", action: "", dialogue: [] as string[] },
      ],
    };
    const received: Array<Partial<CriticContext>> = [];
    const critic: ScriptCritic<typeof screenplay> = {
      criticize(_screenplay, context) {
        received.push({ ...context });
        const f = dir006Finding(2); // scene 2, resolved via lookup
        const sceneId = context.sceneIdLookup?.(2);
        return {
          schemaVersion: CRITIC_SCHEMA_VERSION,
          findings: [sceneId ? { ...f, target: { sceneId } } : f],
          criticId: "adapter",
        };
      },
    };
    const reviser = new RecordingReviser();
    const result = await runRevisionLoop({
      screenplay,
      critic,
      reviser,
      config: { maxIterations: 2 },
      context: { sceneIdLookup: (i) => screenplay.scenes[i - 1]?.sceneId },
    });
    expect(result.stopReason).toBe("no_progress"); // nothing revised changes nothing
    expect(reviser.requests).toHaveLength(1);
    expect(reviser.requests[0]?.affectedScenes).toEqual(["SC-02"]);
    expect(received[0]?.sceneIdLookup).toBeDefined();
    expect(received[0]?.sceneIdLookup?.(1)).toBe("SC-01");
  });
});

describe("signature stability (DIR-007 regression)", () => {
  it("treats signatures of findings with undefined summaries as distinct and sort-safe", () => {
    const f = (id: string): CriticFinding => ({
      schemaVersion: CRITIC_SCHEMA_VERSION,
      id,
      category: "pacing",
      severity: "major",
      summary: (undefined as unknown) as string, // hostile adapter output
    });
    expect(actionableSignature([f("a"), f("b")])).not.toBe(
      actionableSignature([f("b"), f("a"), f("c")]),
    );
  });

  it("excludes unrecognized severities from the stall signature", () => {
    const weird = (id: string): CriticFinding => ({
      schemaVersion: CRITIC_SCHEMA_VERSION,
      id,
      category: "pacing",
      severity: "apocalyptic" as never,
      summary: id,
    });
    expect(actionableSignature([weird("x")])).toBe(actionableSignature([]));
  });
});

describe("revision loop: single-pass convergence on fixture (DIR-007)", () => {
  it("clean screenplay converges with zero revisions", async () => {
    const critic = new ScriptedCritic(["converged"]);
    const reviser = new RecordingReviser();
    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
    });
    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(result.iterationsUsed).toBe(0);
    expect(result.screenplay).toBe(FIXTURE_SCREENPLAY);
    expect(reviser.requests).toHaveLength(0);
  });
});

describe("revision loop: find → revise → re-criticize → converge (DIR-007)", () => {
  it("converges on the fixture within the bound and records the audit trail", async () => {
    // Pass 1: two findings (one targeted SC-02, one global).
    // Pass 2: one remaining minor finding, still actionable.
    // Pass 3: clean.
    const critic = new ScriptedCritic([
      report([finding("F-1", "major", "SC-02", "continuity"), finding("F-2", "minor")]),
      report([finding("F-3", "minor", "SC-01", "dialogue")]),
      "converged",
    ]);
    const reviser = new RecordingReviser(tagRevisedScenes);

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 3 },
    });

    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(result.iterationsUsed).toBe(2);
    expect(result.maxIterations).toBe(3);
    expect(result.iterations).toHaveLength(3);

    // Iteration 1: 2 actionable findings, revised, targeted SC-02 + SC-01 (global).
    expect(result.iterations[0]).toMatchObject({
      index: 1,
      findingsCount: 2,
      actionableCount: 2,
      revised: true,
      findingIds: ["F-1", "F-2"],
    });
    expect(result.iterations[0]?.affectedScenes.sort()).toEqual(["SC-01", "SC-02"]);

    // Iteration 2: 1 finding, revised, targeted SC-01.
    expect(result.iterations[1]).toMatchObject({
      index: 2,
      actionableCount: 1,
      revised: true,
      affectedScenes: ["SC-01"],
      findingIds: ["F-3"],
    });

    // Iteration 3: clean, no revision.
    expect(result.iterations[2]).toMatchObject({
      index: 3,
      findingsCount: 0,
      actionableCount: 0,
      revised: false,
    });

    // Reviser received the actionable findings with correct scope each pass.
    expect(reviser.requests).toHaveLength(2);
    expect(reviser.requests[0]?.findings.map((f) => f.id)).toEqual(["F-1", "F-2"]);
    expect(reviser.requests[0]?.iteration).toBe(1);
    expect(reviser.requests[1]?.findings.map((f) => f.id)).toEqual(["F-3"]);
    expect(reviser.requests[1]?.iteration).toBe(2);

    // Screenplay was actually revised (targeted revisions applied).
    expect(result.screenplay.scenes[1]?.action).toContain("[rev1]");
    expect(result.screenplay.scenes[0]?.action).toContain("[rev2]");

    // Final findings reflect the last critic pass (empty → converged).
    expect(result.finalFindings).toEqual([]);

    // Critic saw the revised screenplay after each revision, plus the revised-scene context.
    expect(critic.calls).toHaveLength(3);
    expect([...(critic.calls[1]?.revisedScenes ?? [])].sort()).toEqual(["SC-01", "SC-02"]);
    expect(critic.calls[2]?.revisedScenes).toEqual(["SC-01"]);
    expect(critic.calls[1]?.screenplay.scenes[1]?.action).toContain("[rev1]");
  });
});

describe("revision loop: bounding (DIR-007)", () => {
  it("stops at max_iterations when the critic never converges", async () => {
    const critic = new ScriptedCritic([
      report([finding("F-A", "blocker")]),
      report([finding("F-B", "blocker")]),
      report([finding("F-C", "blocker")]),
      report([finding("F-D", "blocker")]),
    ]);
    const reviser = new RecordingReviser(tagRevisedScenes);

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 3 },
    });

    expect(result.converged).toBe(false);
    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterationsUsed).toBe(3); // exactly maxIterations reviser calls
    expect(reviser.requests).toHaveLength(3);
    // Four critic passes: initial + after each of 3 revisions.
    expect(critic.calls).toHaveLength(4);
    // Findings changed each pass, so progress was being made.
    expect(result.iterations[3]?.revised).toBe(false);
    expect(result.finalFindings.map((f) => f.id)).toEqual(["F-D"]);
  });

  it("respects maxIterations = 0: critic-only, never revises", async () => {
    const critic = new ScriptedCritic([report([finding("F-1", "major")])]);
    const reviser = new RecordingReviser();

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 0 },
    });

    expect(result.converged).toBe(false);
    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterationsUsed).toBe(0);
    expect(reviser.requests).toHaveLength(0);
    expect(result.finalFindings.map((f) => f.id)).toEqual(["F-1"]);
  });

  it("stops with no_progress when identical actionable findings repeat", async () => {
    const same = () => report([finding("F-stuck", "major", "SC-02")]);
    const critic = new ScriptedCritic([same(), same(), same()]);
    const reviser = new RecordingReviser(); // reviser changes nothing

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 5 },
    });

    expect(result.converged).toBe(false);
    expect(result.stopReason).toBe("no_progress");
    // Pass 1 revised, pass 2 same findings → stop. No third pass.
    expect(result.iterationsUsed).toBe(1);
    expect(reviser.requests).toHaveLength(1);
    expect(critic.calls).toHaveLength(2);
  });
});

describe("revision loop: severity threshold filtering (DIR-007)", () => {
  it("ignores findings below actionableAtSeverity and converges", async () => {
    const critic = new ScriptedCritic([report([finding("F-minor", "minor")])]);
    const reviser = new RecordingReviser();

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 3, actionableAtSeverity: "major" },
    });

    expect(result.converged).toBe(true);
    expect(result.stopReason).toBe("converged");
    expect(result.iterationsUsed).toBe(0);
    expect(reviser.requests).toHaveLength(0);
    // Below-threshold finding is still recorded in the audit trail + final findings.
    expect(result.iterations[0]?.findingsCount).toBe(1);
    expect(result.iterations[0]?.actionableCount).toBe(0);
    expect(result.finalFindings.map((f) => f.id)).toEqual(["F-minor"]);
  });
});

describe("revision loop: contract enforcement (DIR-007)", () => {
  it("rejects critic reports with a wrong schemaVersion", async () => {
    const bad = { schemaVersion: 99 as never, findings: [] };
    const critic = { criticize: () => bad };
    await expect(
      runRevisionLoop({ screenplay: FIXTURE_SCREENPLAY, critic, reviser: new RecordingReviser() }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it("rejects a critic report containing null/primitive findings with RevisionLoopError", async () => {
    // Hostile adapter output: findings array with non-object elements must
    // fail as a contract violation, not crash the loop with a TypeError.
    for (const bad of [null, "x", 42, []]) {
      const badReport = {
        schemaVersion: CRITIC_SCHEMA_VERSION,
        findings: [bad as unknown as CriticFinding],
      };
      const critic = { criticize: () => badReport };
      await expect(
        runRevisionLoop({
          screenplay: FIXTURE_SCREENPLAY,
          critic,
          reviser: new RecordingReviser(),
        }),
      ).rejects.toThrow(RevisionLoopError);
    }
  });

  it("rejects a reviser that returns null/undefined", async () => {
    const critic = new ScriptedCritic([report([finding("F-1")])]);
    const reviser = { revise: () => undefined as unknown as FixtureScreenplay };
    await expect(
      runRevisionLoop({
        screenplay: FIXTURE_SCREENPLAY,
        critic,
        reviser,
        config: { maxIterations: 2 },
      }),
    ).rejects.toThrow(RevisionLoopError);
  });

  it("never mutates the input screenplay (reviser returns a new value)", async () => {
    const critic = new ScriptedCritic([
      report([finding("F-1", "major", "SC-01")]),
      "converged",
    ]);
    const reviser = new RecordingReviser(tagRevisedScenes);
    const snapshot = JSON.stringify(FIXTURE_SCREENPLAY);

    const result = await runRevisionLoop({
      screenplay: FIXTURE_SCREENPLAY,
      critic,
      reviser,
      config: { maxIterations: 2 },
    });

    expect(JSON.stringify(FIXTURE_SCREENPLAY)).toBe(snapshot); // input untouched
    expect(result.screenplay).not.toBe(FIXTURE_SCREENPLAY); // new value
    expect(result.screenplay.scenes[0]?.action).toContain("[rev1]");
  });
});

describe("actionableSignature (DIR-007)", () => {
  it("is order-insensitive and id-driven", () => {
    const a = [finding("F-1", "major", "SC-01"), finding("F-2", "minor")];
    const b = [finding("F-2", "minor"), finding("F-1", "major", "SC-01")];
    expect(actionableSignature(a)).toBe(actionableSignature(b));
    expect(actionableSignature(a)).not.toBe(actionableSignature([finding("F-3")]));
  });
});