import { describe, expect, it } from "vitest";
import {
  CRITIC_CATEGORY_CODES,
  HeuristicCriticModel,
  RemoteCriticModel,
  type Screenplay,
} from "./critic-model.js";
import { CriticSchemaError, type ScriptCritique } from "./schema.js";
import { CLEAN_SCREENPLAY, FLAWED_SCREENPLAY, FIXTURE_CONTEXT } from "./fixture.js";

const FIXED_NOW = () => "2026-08-28T12:00:00.000Z";

describe("HeuristicCriticModel", () => {
  it("returns a versioned critique with the four categories counted", async () => {
    const critic = new HeuristicCriticModel("heuristic-test", { now: FIXED_NOW });
    const critique = await critic.critique(CLEAN_SCREENPLAY, FIXTURE_CONTEXT);
    expect(critique.schemaVersion).toBe(1);
    expect(critique.screenplayId).toBe(CLEAN_SCREENPLAY.id);
    expect(critique.criticModelId).toBe("heuristic-test");
    expect(critique.createdAt).toBe("2026-08-28T12:00:00.000Z");
    expect(Object.keys(critique.counts).sort()).toEqual(
      ["character-consistency", "continuity", "dialogue", "pacing"].sort(),
    );
    for (const f of critique.findings) {
      expect(["pacing", "continuity", "dialogue", "character-consistency"]).toContain(f.category);
    }
  });

  it("passes the clean fixture screenplay", async () => {
    const critic = new HeuristicCriticModel("heuristic-test", { now: FIXED_NOW });
    const critique = await critic.critique(CLEAN_SCREENPLAY, FIXTURE_CONTEXT);
    expect(critique.verdict).toBe("pass");
    expect(critique.findings).toEqual([]);
  });

  it("PAC-static: flags a scene far off the ensemble duration mean", async () => {
    const screenplay: Screenplay = {
      id: "s1",
      title: "t",
      logline: "l",
      scenes: [
        { index: 1, heading: "INT. A - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
        { index: 2, heading: "INT. B - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 22 },
        { index: 3, heading: "INT. C - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 120 },
      ],
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    const pac = critique.findings.filter((f) => f.rule === "PAC-static");
    expect(pac.length).toBeGreaterThanOrEqual(1);
    expect(pac.some((f) => f.location.sceneIndex === 3)).toBe(true);
    expect(critique.counts.pacing).toBe(pac.length);
  });

  it("PAC-rushed: flags dialogue crammed into too little runtime", async () => {
    const screenplay: Screenplay = {
      id: "s2",
      title: "t",
      logline: "l",
      scenes: [
        {
          index: 1,
          heading: "INT. A - NIGHT",
          action: "a",
          dialogue: [
            { character: "A", text: "one" },
            { character: "B", text: "two" },
            { character: "A", text: "three" },
            { character: "B", text: "four" },
          ],
          plannedDurationSeconds: 8,
        },
      ],
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    expect(critique.findings.some((f) => f.rule === "PAC-rushed")).toBe(true);
  });

  it("PAC-empty: critical finding for a screenplay with no scenes", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique({
      id: "s0",
      title: "t",
      logline: "l",
      scenes: [],
    });
    const empty = critique.findings.find((f) => f.rule === "PAC-empty");
    expect(empty?.severity).toBe("critical");
    expect(critique.verdict).toBe("revise");
  });

  it("CON-ghost: flags a recurring location that never returns", async () => {
    const screenplay: Screenplay = {
      id: "s5",
      title: "t",
      logline: "l",
      scenes: [
        { index: 1, heading: "INT. BAKERY - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
        { index: 2, heading: "INT. BAKERY - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
        { index: 3, heading: "INT. TUNNEL - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
      ],
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    const ghost = critique.findings.find((f) => f.rule === "CON-ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.category).toBe("continuity");
    expect(ghost?.detail).toContain("int. bakery");
  });

  it("CON-canon: flags action negating a continuity note", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      FLAWED_SCREENPLAY,
      FIXTURE_CONTEXT,
    );
    const canon = critique.findings.filter((f) => f.rule === "CON-canon");
    expect(canon.length).toBeGreaterThanOrEqual(1);
    expect(canon.some((f) => f.location.sceneIndex === 2)).toBe(true);
  });

  it("DIA-banned: flags a banned phrase from the character sheet", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique({
      id: "s3",
      title: "t",
      logline: "l",
      scenes: [
        {
          index: 1,
          heading: "INT. A - NIGHT",
          action: "a",
          dialogue: [{ character: "MARA", text: "Relax, it's a piece of cake." }],
          plannedDurationSeconds: 20,
        },
      ],
    }, FIXTURE_CONTEXT);
    const banned = critique.findings.filter((f) => f.rule === "DIA-banned");
    expect(banned.length).toBe(1);
    expect(banned[0]?.location.character).toBe("MARA");
  });

  it("DIA-monolog: flags an outlier monologue on the flawed fixture", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      FLAWED_SCREENPLAY,
      FIXTURE_CONTEXT,
    );
    const mono = critique.findings.filter((f) => f.rule === "DIA-monolog");
    expect(mono.length).toBe(1);
    expect(mono[0]?.location.sceneIndex).toBe(3);
  });

  it("CHA-physical: flags action contradicting the physical sheet", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      FLAWED_SCREENPLAY,
      FIXTURE_CONTEXT,
    );
    const phys = critique.findings.filter((f) => f.rule === "CHA-physical");
    expect(phys.length).toBeGreaterThanOrEqual(1);
    expect(phys.some((f) => f.location.character === "MARA")).toBe(true);
  });

  it("CHA-drift: flags dialogue contradicting the voice sheet", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique({
      id: "s4",
      title: "t",
      logline: "l",
      scenes: [
        {
          index: 1,
          heading: "INT. A - NIGHT",
          action: "a",
          dialogue: [{ character: "MARA", text: "I am never short with anyone, listen closely." }],
          plannedDurationSeconds: 20,
        },
      ],
    }, FIXTURE_CONTEXT);
    const drift = critique.findings.filter((f) => f.rule === "CHA-drift");
    expect(drift.length).toBeGreaterThanOrEqual(1);
  });

  it("assigns stable, unique, category-prefixed finding ids", async () => {
    const critic = new HeuristicCriticModel("t", { now: FIXED_NOW });
    const critique = await critic.critique(FLAWED_SCREENPLAY, FIXTURE_CONTEXT);
    const ids = critique.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of critique.findings) {
      expect(f.id.startsWith(CRITIC_CATEGORY_CODES[f.category])).toBe(true);
    }
    // Deterministic across runs.
    const again = await critic.critique(FLAWED_SCREENPLAY, FIXTURE_CONTEXT);
    expect(again.findings.map((f) => f.id)).toEqual(ids);
  });

  it("reviseOnSeverity controls the verdict threshold", async () => {
    const lax = new HeuristicCriticModel("t", { reviseOnSeverity: "critical", now: FIXED_NOW });
    const critique = await lax.critique(FLAWED_SCREENPLAY, FIXTURE_CONTEXT);
    const hasCritical = critique.findings.some((f) => f.severity === "critical");
    expect(critique.verdict).toBe(hasCritical ? "revise" : "pass");
  });
});

describe("RemoteCriticModel", () => {
  const screenplay = CLEAN_SCREENPLAY;

  function validJson(criticId: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      screenplayId: screenplay.id,
      criticModelId: criticId,
      createdAt: "2026-08-28T12:00:00.000Z",
      verdict: "pass",
      findings: [],
      counts: { pacing: 0, continuity: 0, dialogue: 0, "character-consistency": 0 },
    } satisfies ScriptCritique);
  }

  it("builds a prompt embedding the screenplay and context", () => {
    const remote = new RemoteCriticModel({ id: "glm-5.3-flash", complete: async () => "" });
    const prompt = remote.buildPrompt(FLAWED_SCREENPLAY, FIXTURE_CONTEXT);
    expect(prompt).toContain("SCENE 1 [INT. BAKERY - NIGHT]");
    expect(prompt).toContain("CHARACTER MARA");
    expect(prompt).toContain("CONTINUITY: blueprint:");
    expect(prompt).toContain('"schemaVersion":1');
  });

  it("returns a valid critique for well-formed model output", async () => {
    const remote = new RemoteCriticModel({
      id: "glm-5.3-flash",
      complete: async (prompt) => {
        expect(prompt.length).toBeGreaterThan(0);
        return validJson("glm-5.3-flash");
      },
    });
    const critique = await remote.critique(screenplay, FIXTURE_CONTEXT);
    expect(critique.verdict).toBe("pass");
    expect(critique.criticModelId).toBe("glm-5.3-flash");
  });

  it("rejects non-JSON output with CriticSchemaError", async () => {
    const remote = new RemoteCriticModel({ id: "m", complete: async () => "<html>nope</html>" });
    await expect(remote.critique(screenplay)).rejects.toBeInstanceOf(CriticSchemaError);
  });

  it("rejects output that violates the versioned schema", async () => {
    const bad = JSON.parse(validJson("m")) as Record<string, unknown>;
    bad["schemaVersion"] = 99;
    const remote = new RemoteCriticModel({ id: "m", complete: async () => JSON.stringify(bad) });
    await expect(remote.critique(screenplay)).rejects.toThrow(/newer than supported/);
  });

  it("rejects output referencing a different screenplay id", async () => {
    const stolen = JSON.parse(validJson("m")) as Record<string, unknown>;
    stolen["screenplayId"] = "someone-elses-script";
    const remote = new RemoteCriticModel({ id: "m", complete: async () => JSON.stringify(stolen) });
    await expect(remote.critique(screenplay)).rejects.toThrow(/does not match expected/);
  });
});