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

  it("PAC-rushed: does not false-flag healthy multi-scene pacing", async () => {
    // 4 scenes x 30s = 120s planned runtime for 15 lines -> 8s/line, healthy.
    // Regression: the old mean-per-scene math computed 30/15 = 2s and flagged it.
    const screenplay: Screenplay = {
      id: "s2b",
      title: "t",
      logline: "l",
      scenes: [1, 2, 3, 4].map((i) => ({
        index: i,
        heading: `INT. S${i} - NIGHT`,
        action: "a",
        dialogue: Array.from({ length: 4 }, (_, k) => ({
          character: "A",
          text: `line ${i}-${k}`,
        })),
        plannedDurationSeconds: 30,
      })),
    };
    screenplay.scenes[0]!.dialogue = [...screenplay.scenes[0]!.dialogue.slice(0, 3)];
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    expect(critique.findings.filter((f) => f.rule === "PAC-rushed")).toEqual([]);
  });

  it("PAC-rushed: still flags genuinely crammed dialogue", async () => {
    // Single 8s scene with 4 lines -> 2s/line, genuinely rushed.
    const screenplay: Screenplay = {
      id: "s2c",
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

  it("CON-ghost: does not flag a location that runs through the final scene", async () => {
    const screenplay: Screenplay = {
      id: "s5b",
      title: "t",
      logline: "l",
      scenes: [1, 2, 3].map((i) => ({
        index: i,
        heading: "INT. BAKERY - NIGHT",
        action: "a",
        dialogue: [],
        plannedDurationSeconds: 20,
      })),
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    expect(critique.findings.filter((f) => f.rule === "CON-ghost")).toEqual([]);
  });

  it("CON-ghost: flags abandonment correctly with 0-based scene indices", async () => {
    // Scene indices are 0-based and the location truly abandons after
    // position 2 of 3 — position math must not depend on scene.index.
    const screenplay: Screenplay = {
      id: "s5c",
      title: "t",
      logline: "l",
      scenes: [
        { index: 0, heading: "INT. BAKERY - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
        { index: 1, heading: "INT. BAKERY - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
        { index: 2, heading: "INT. TUNNEL - NIGHT", action: "a", dialogue: [], plannedDurationSeconds: 20 },
      ],
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(screenplay);
    const ghost = critique.findings.find((f) => f.rule === "CON-ghost");
    expect(ghost).toBeDefined();
    // Anchored by 1-based scene POSITION, not the screenplay's scene.index.
    expect(ghost?.location.sceneIndex).toBe(1);
    expect(ghost?.detail).toContain("never returns after scene 2");
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

  it("DIA-banned: ignores empty banned-phrase entries instead of matching every line", async () => {
    const screenplay: Screenplay = {
      id: "s3b",
      title: "t",
      logline: "l",
      scenes: [
        {
          index: 1,
          heading: "INT. A - NIGHT",
          action: "a",
          dialogue: [{ character: "MARA", text: "Hello there." }],
          plannedDurationSeconds: 20,
        },
      ],
    };
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      screenplay,
      { characters: [{ name: "MARA", bannedPhrases: ["", "  "] }] },
    );
    expect(critique.findings.filter((f) => f.rule === "DIA-banned")).toEqual([]);
    expect(critique.verdict).toBe("pass");
  });

  it("DIA-banned: does not match mid-word substrings (word-boundary regression)", async () => {
    // "art" must not match inside "start"; "trust me" must not match inside
    // "distrust me". The old bare includes() fed DIR-007 false findings.
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      {
        id: "s3c",
        title: "t",
        logline: "l",
        scenes: [
          {
            index: 1,
            heading: "INT. A - NIGHT",
            action: "a",
            dialogue: [
              { character: "MARA", text: "Let us start the artwork tonight." },
              { character: "MARA", text: "I distrust me some shortcuts, said nobody." },
            ],
            plannedDurationSeconds: 20,
          },
        ],
      },
      { characters: [{ name: "MARA", bannedPhrases: ["art", "trust me"] }] },
    );
    expect(critique.findings.filter((f) => f.rule === "DIA-banned")).toEqual([]);
    expect(critique.verdict).toBe("pass");
  });

  it("DIA-banned: still flags the standalone phrase after boundary fix", async () => {
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      {
        id: "s3d",
        title: "t",
        logline: "l",
        scenes: [
          {
            index: 1,
            heading: "INT. A - NIGHT",
            action: "a",
            dialogue: [{ character: "MARA", text: "Trust me, it is a piece of cake." }],
            plannedDurationSeconds: 20,
          },
        ],
      },
      FIXTURE_CONTEXT,
    );
    const banned = critique.findings.filter((f) => f.rule === "DIA-banned");
    expect(banned.length).toBe(2); // "trust me" and "piece of cake"
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

  it("negation matchers: mid-word 'not calm' never satisfies via 'cannot calm' (boundary regression)", async () => {
    // "cannot calm" contains "not calm" as a substring; only whole-word
    // negation matching may flag it. Voice sheet trait "calm under pressure"
    // must NOT produce CHA-drift on this line.
    const critique = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      {
        id: "s6",
        title: "t",
        logline: "l",
        scenes: [
          {
            index: 1,
            heading: "INT. A - NIGHT",
            action: "a",
            dialogue: [{ character: "DEACON", text: "I cannot calm the scanner, it keeps beeping." }],
            plannedDurationSeconds: 20,
          },
        ],
      },
      FIXTURE_CONTEXT,
    );
    expect(critique.findings.filter((f) => f.rule === "CHA-drift")).toEqual([]);
    // And the real negation still fires.
    const negated = await new HeuristicCriticModel("t", { now: FIXED_NOW }).critique(
      {
        id: "s6b",
        title: "t",
        logline: "l",
        scenes: [
          {
            index: 1,
            heading: "INT. A - NIGHT",
            action: "a",
            dialogue: [{ character: "DEACON", text: "I am never calm when the alarm blares." }],
            plannedDurationSeconds: 20,
          },
        ],
      },
      FIXTURE_CONTEXT,
    );
    expect(negated.findings.filter((f) => f.rule === "CHA-drift").length).toBeGreaterThanOrEqual(1);
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