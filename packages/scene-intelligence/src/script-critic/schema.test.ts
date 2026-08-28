import { beforeAll, describe, expect, it } from "vitest";
import {
  assembleCritique,
  countsFromFindings,
  CRITIC_CATEGORIES,
  CRITIC_SEVERITIES,
  CriticSchemaError,
  parseCritique,
  SCRIPT_CRITIC_SCHEMA_VERSION,
  verdictFromFindings,
  type ScriptCritique,
  type ScriptFinding,
} from "./schema.js";
import { HeuristicCriticModel } from "./critic-model.js";
import { FLAWED_SCREENPLAY, FIXTURE_CONTEXT } from "./fixture.js";

function makeFinding(overrides: Partial<ScriptFinding> = {}): ScriptFinding {
  return {
    id: "PAC-001",
    rule: "PAC-static",
    category: "pacing",
    severity: "minor",
    title: "t",
    detail: "d",
    suggestion: null,
    location: { sceneIndex: null, line: null, character: null },
    ...overrides,
  };
}

function assembleValid(findings: ScriptFinding[]): ScriptCritique {
  return assembleCritique({
    screenplayId: "fx-1",
    criticModelId: "m1",
    createdAt: "2026-08-28T00:00:00.000Z",
    findings,
    reviseOnSeverity: "major",
  });
}

describe("script critic schema", () => {
  it("exposes schemaVersion 1 and the four mandated categories", () => {
    expect(SCRIPT_CRITIC_SCHEMA_VERSION).toBe(1);
    expect([...CRITIC_CATEGORIES]).toEqual([
      "pacing",
      "continuity",
      "dialogue",
      "character-consistency",
    ]);
    expect([...CRITIC_SEVERITIES]).toEqual(["info", "minor", "major", "critical"]);
  });

  it("assembles a complete, consistent critique envelope", () => {
    const findings = [
      makeFinding({ id: "PAC-001", category: "pacing", severity: "minor" }),
      makeFinding({ id: "DIA-001", category: "dialogue", severity: "major" }),
    ];
    const critique = assembleValid(findings);
    expect(critique.schemaVersion).toBe(1);
    expect(critique.verdict).toBe("revise");
    expect(critique.counts).toEqual({
      pacing: 1,
      continuity: 0,
      dialogue: 1,
      "character-consistency": 0,
    });
  });

  it("verdictFromFindings passes below threshold and revises at/above", () => {
    const minorOnly = [makeFinding({ severity: "minor" })];
    expect(verdictFromFindings(minorOnly, "major")).toBe("pass");
    expect(verdictFromFindings(minorOnly, "minor")).toBe("revise");
    expect(verdictFromFindings([makeFinding({ severity: "critical" })], "major")).toBe("revise");
  });

  it("countsFromFindings throws on an unknown category", () => {
    const bad = [makeFinding({ category: "nonsense" as never })];
    expect(() => countsFromFindings(bad)).toThrow(CriticSchemaError);
  });

  describe("parseCritique", () => {
    let validCritique: ScriptCritique;
    beforeAll(() => {
      validCritique = assembleValid([
        makeFinding({ id: "CON-001", category: "continuity", severity: "info" }),
      ]);
    });

    it("accepts a valid critique round-trip", () => {
      const round = parseCritique(JSON.parse(JSON.stringify(validCritique)), {
        expectedScreenplayId: "fx-1",
      });
      expect(round).toEqual(validCritique);
    });

    it("rejects non-object input and newer schema versions", () => {
      expect(() => parseCritique("nope")).toThrow(CriticSchemaError);
      expect(() => parseCritique(null)).toThrow(CriticSchemaError);
      expect(() => parseCritique({ ...validCritique, schemaVersion: 2 })).toThrow(
        /newer than supported/,
      );
      expect(() => parseCritique({ ...validCritique, schemaVersion: "1" })).toThrow(
        CriticSchemaError,
      );
    });

    it("rejects mismatched screenplayId when expected", () => {
      expect(() => parseCritique(validCritique, { expectedScreenplayId: "other" })).toThrow(
        /does not match expected/,
      );
    });

    it("rejects unknown category, severity, verdict, duplicate ids", () => {
      const dup = {
        ...validCritique,
        findings: [makeFinding({ id: "X-1" }), makeFinding({ id: "X-1", rule: "r2" })],
      };
      expect(() => parseCritique(dup)).toThrow(/duplicated/);
      expect(() =>
        parseCritique({
          ...validCritique,
          findings: [makeFinding({ category: "vibes" as never })],
        }),
      ).toThrow(/category/);
      expect(() =>
        parseCritique({
          ...validCritique,
          findings: [makeFinding({ severity: "apocalyptic" as never })],
        }),
      ).toThrow(/severity/);
      expect(() => parseCritique({ ...validCritique, verdict: "maybe" })).toThrow(/verdict/);
    });

    it("rejects counts inconsistent with findings", () => {
      expect(() =>
        parseCritique({
          ...validCritique,
          counts: { pacing: 5, continuity: 0, dialogue: 0, "character-consistency": 0 },
        }),
      ).toThrow(/counts\.pacing/);
      expect(() =>
        parseCritique({
          ...validCritique,
          counts: {
            pacing: 0,
            continuity: 1,
            dialogue: 0,
            "character-consistency": 0,
            vibes: 1,
          },
        }),
      ).toThrow(/unknown keys/);
    });

    it("rejects a verdict inconsistent with the severity threshold", () => {
      const findings = [makeFinding({ severity: "major" })];
      const critique = assembleValid(findings);
      expect(critique.verdict).toBe("revise");
      expect(() =>
        parseCritique({ ...critique, verdict: "pass" }, { reviseOnSeverity: "major" }),
      ).toThrow(/verdict/);
      // Under a stricter revise threshold the same findings imply "pass",
      // so the "revise" verdict is now the inconsistent one.
      expect(() =>
        parseCritique(JSON.parse(JSON.stringify(critique)), { reviseOnSeverity: "critical" }),
      ).toThrow(/verdict.*is "revise" but findings imply "pass"/);
    });

    it("rejects malformed finding locations", () => {
      expect(() =>
        parseCritique({
          ...validCritique,
          findings: [makeFinding({ location: { sceneIndex: 0, line: null, character: null } })],
        }),
      ).toThrow(/positive integer/);
      expect(() =>
        parseCritique({ ...validCritique, findings: [makeFinding({ location: null as never })] }),
      ).toThrow(/location/);
    });
  });

  describe("fixture wiring", () => {
    it("heuristic critic finds defects in FLAWED_SCREENPLAY", async () => {
      const critic = new HeuristicCriticModel("t");
      const critique = await critic.critique(FLAWED_SCREENPLAY, FIXTURE_CONTEXT);
      expect(critique.verdict).toBe("revise");
      expect(critique.findings.length).toBeGreaterThan(0);
    });
  });
});