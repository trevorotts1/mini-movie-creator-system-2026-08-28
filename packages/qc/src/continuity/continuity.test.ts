/**
 * QC-004 tests — continuity neighbor check (spec §11): neighboring shots
 * compared against each other and the current Series Bible state.
 * The `breakScene` fixture must be flagged; the `cleanScene` control must
 * come back clean.
 */

import { describe, expect, it } from "vitest";

import {
  CONTINUITY_FINDING_CODES,
  ContinuityCheckError,
  resolveBibleAppearance,
  runContinuityCheck,
  type ContinuityShot,
} from "./continuity.js";
import { bible, breakScene, cleanScene } from "./fixtures.js";

describe("runContinuityCheck — neighbor pairs (spec §11)", () => {
  it("flags the continuity-break fixture", () => {
    const result = runContinuityCheck({ shots: breakScene, bible });
    expect(result.ok).toBe(false);

    const codes = result.findings.map((f) => f.code).sort();
    expect(codes).toEqual(
      [
        "bible-hair-mismatch",
        "bible-location-state",
        "bible-wardrobe-mismatch",
        "hair-jump",
        "location-jump",
        "prop-vanish",
        "state-mismatch",
        "time-of-day-jump",
        "wardrobe-jump",
      ].sort(),
    );
  });

  it("names both shots of the breaking neighbor pair", () => {
    const result = runContinuityCheck({ shots: breakScene, bible });
    const locationJump = result.findings.find((f) => f.code === "location-jump");
    expect(locationJump).toBeDefined();
    expect(locationJump?.shotIds).toEqual(["SHOT_S01E05_002", "SHOT_S01E05_003"]);
    expect(locationJump?.sceneId).toBe("SCENE_KITCHEN_001");
    expect(locationJump?.message).toContain("LOC_KITCHEN_001");
    expect(locationJump?.message).toContain("LOC_LIVING_ROOM_001");
  });

  it("does not flag the clean control scene", () => {
    const result = runContinuityCheck({ shots: cleanScene, bible });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("treats a new prop as fine while a vanishing prop is a break", () => {
    const clean = runContinuityCheck({ shots: cleanScene });
    expect(clean.findings.some((f) => f.code === "prop-vanish")).toBe(false);

    const shrink: ContinuityShot[] = [
      {
        ...cleanScene[0]!,
        props: ["PROP_COFFEE_MUG_001", "PROP_SPOON_001"],
        startState: "door-closed",
        endState: "door-open",
      },
      { ...cleanScene[1]!, props: ["PROP_COFFEE_MUG_001"], startState: "door-open" },
    ];
    const shrinkResult = runContinuityCheck({ shots: shrink });
    expect(shrinkResult.ok).toBe(false);
    expect(shrinkResult.findings.map((f) => f.code)).toEqual(["prop-vanish"]);
  });

  it("only pairs neighbors within the same scene", () => {
    const shots: ContinuityShot[] = [
      {
        shotId: "A1",
        sceneId: "SCENE_A",
        sequenceIndex: 1,
        location: "LOC_KITCHEN_001",
        timeOfDay: "day",
        endState: "door-open",
      },
      {
        shotId: "B1",
        sceneId: "SCENE_B",
        sequenceIndex: 2,
        location: "LOC_LIVING_ROOM_001",
        timeOfDay: "night",
        startState: "lights-off",
      },
    ];
    const result = runContinuityCheck({ shots });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("orders neighbors by sequenceIndex regardless of input order", () => {
    const shuffled: ContinuityShot[] = [breakScene[1], breakScene[2], breakScene[0]].map(
      (shot) => shot as ContinuityShot,
    );
    const fromShuffled = runContinuityCheck({ shots: shuffled, bible });
    const fromOrdered = runContinuityCheck({ shots: breakScene, bible });
    expect(fromShuffled.findings.map((f) => f.code).sort()).toEqual(
      fromOrdered.findings.map((f) => f.code).sort(),
    );
    const locationJump = fromShuffled.findings.find((f) => f.code === "location-jump");
    expect(locationJump?.shotIds).toEqual(["SHOT_S01E05_002", "SHOT_S01E05_003"]);
  });
});

describe("resolveBibleAppearance — canon-at-the-time (spec §9 immutable history)", () => {
  it("resolves v1 before the change episode and v2 from it", () => {
    expect(resolveBibleAppearance(bible, "CHAR_MONICA_BENNETT_001", "S01E05")?.versionLabel).toBe("v1");
    expect(resolveBibleAppearance(bible, "CHAR_MONICA_BENNETT_001", "S01E08")?.versionLabel).toBe("v1");
    expect(resolveBibleAppearance(bible, "CHAR_MONICA_BENNETT_001", "S01E09")?.versionLabel).toBe("v2");
  });

  it("returns null without a shot episode (canon point undetermined)", () => {
    expect(resolveBibleAppearance(bible, "CHAR_MONICA_BENNETT_001", undefined)).toBeNull();
  });

  it("returns null for an unknown character", () => {
    expect(resolveBibleAppearance(bible, "CHAR_NOBODY_999", "S01E05")).toBeNull();
  });
});

describe("runContinuityCheck — Series Bible state (spec §10/§11)", () => {
  it("accepts a bible-matching clean scene and rejects a wardrobe contradiction", () => {
    const result = runContinuityCheck({ shots: cleanScene, bible });
    expect(result.ok).toBe(true);

    const contradiction: ContinuityShot[] = [
      {
        ...cleanScene[0]!,
        wardrobe: { CHAR_MONICA_BENNETT_001: "sweater-green" },
      },
    ];
    const contradicted = runContinuityCheck({ shots: contradiction, bible });
    expect(contradicted.ok).toBe(false);
    const finding = contradicted.findings[0];
    expect(finding?.code).toBe("bible-wardrobe-mismatch");
    expect(finding?.message).toContain("v1");
  });

  it("flags a bible-hair contradiction (S01E05 resolves v1 braids)", () => {
    const shots: ContinuityShot[] = [
      {
        shotId: "SHOT_HAIR_1",
        sceneId: "SCENE_KITCHEN_001",
        sequenceIndex: 1,
        episode: "S01E05",
        characters: ["CHAR_MONICA_BENNETT_001"],
        hair: { CHAR_MONICA_BENNETT_001: "short-hair-v2" },
      },
    ];
    const result = runContinuityCheck({ shots, bible });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(["bible-hair-mismatch"]);
  });

  it("flags an unapproved location day/night state", () => {
    const shots: ContinuityShot[] = [
      {
        shotId: "SHOT_STORM_1",
        sceneId: "SCENE_LIVING_ROOM_001",
        sequenceIndex: 1,
        episode: "S01E05",
        location: "LOC_LIVING_ROOM_001",
        timeOfDay: "storm",
      },
    ];
    const result = runContinuityCheck({ shots, bible });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(["bible-location-state"]);
  });

  it("skips bible checks when no bible is supplied", () => {
    const result = runContinuityCheck({ shots: breakScene });
    expect(result.findings.every((f) => !f.code.startsWith("bible-"))).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe("runContinuityCheck — input validation", () => {
  it("throws on an empty shotId", () => {
    const shots: ContinuityShot[] = [
      { shotId: "", sceneId: "SCENE_A", sequenceIndex: 1 },
    ];
    expect(() => runContinuityCheck({ shots })).toThrow(ContinuityCheckError);
  });

  it("throws on a duplicate shotId", () => {
    const shots: ContinuityShot[] = [
      { shotId: "DUP", sceneId: "SCENE_A", sequenceIndex: 1 },
      { shotId: "DUP", sceneId: "SCENE_A", sequenceIndex: 2 },
    ];
    expect(() => runContinuityCheck({ shots })).toThrow(/duplicate shotId/);
  });

  it("throws on a non-integer sequenceIndex", () => {
    const shots: ContinuityShot[] = [
      {
        shotId: "X1",
        sceneId: "SCENE_A",
        sequenceIndex: 1.5,
      } as ContinuityShot,
    ];
    expect(() => runContinuityCheck({ shots })).toThrow(ContinuityCheckError);
  });

  it("accepts an empty shot list", () => {
    const result = runContinuityCheck({ shots: [], bible });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("emits only known finding codes", () => {
    const result = runContinuityCheck({ shots: breakScene, bible });
    for (const finding of result.findings) {
      expect(CONTINUITY_FINDING_CODES).toContain(finding.code);
    }
  });
});