import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVISION_LOOP_CONFIG,
  CRITIC_SCHEMA_VERSION,
  affectedSceneIds,
  isActionable,
  resolveRevisionLoopConfig,
  runRevisionLoop,
  RevisionLoopError,
  actionableSignature,
  finding,
} from "./index.js";
import {
  FIXTURE_SCREENPLAY,
  RecordingReviser,
  ScriptedCritic,
  tagRevisedScenes,
  type FixtureScreenplay,
} from "./fixtures.js";

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
    const screenplay = { scenes: [{ id: "SC-01" }, { id: "SC-02" }, { id: "SC-03" }] };
    expect(
      affectedSceneIds(screenplay, [finding("f1", "major", "SC-02"), finding("f2", "major", "SC-03")]),
    ).toEqual(["SC-02", "SC-03"]);
    expect(affectedSceneIds(screenplay, [finding("f1", "major")])).toEqual([
      "SC-01",
      "SC-02",
      "SC-03",
    ]);
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