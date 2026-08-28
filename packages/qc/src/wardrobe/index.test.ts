import { describe, expect, it } from "vitest";

import {
  checkAppearance,
  checkShot,
  overallStatus,
  resolveActiveAppearance,
  WardrobeCheckError,
  type AppearanceHistoryInput,
  type ShotAppearanceCheckInput,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";

/**
 * Monica per spec §9: v1 long braids + business-blue from S01E01,
 * v2 short bob from S01E09 (haircut), field jacket from S01E12.
 */
function monicaHistory(): AppearanceHistoryInput {
  return {
    characterId: MONICA,
    baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
    versions: [
      {
        versionLabel: "v1",
        hairVersion: "long-braids-v1",
        wardrobeVersion: "business-blue-v1",
        baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
        state: "CANONICAL",
        effectiveEpisode: "S01E01",
      },
      {
        versionLabel: "v2",
        hairVersion: "short-bob-v2",
        wardrobeVersion: "business-blue-v1",
        baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
        state: "CANONICAL",
        effectiveEpisode: "S01E09",
        changeNote: "cut the braids — short hair from E09",
      },
      {
        versionLabel: "v3",
        hairVersion: "short-bob-v2",
        wardrobeVersion: "field-jacket-v3",
        baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
        state: "CANONICAL",
        effectiveEpisode: "S01E12",
        changeNote: "field jacket for the stakeout",
      },
    ],
  };
}

describe("resolveActiveAppearance — canon-at-the-time", () => {
  it("resolves v1 braids for E01–E08", () => {
    const active = resolveActiveAppearance(monicaHistory(), { episode: "S01E04" });
    expect(active.versionLabel).toBe("v1");
    expect(active.hairVersion).toBe("long-braids-v1");
    expect(active.wardrobeVersion).toBe("business-blue-v1");
  });

  it("resolves v2 short bob from E09", () => {
    const active = resolveActiveAppearance(monicaHistory(), { episode: "S01E10" });
    expect(active.versionLabel).toBe("v2");
    expect(active.hairVersion).toBe("short-bob-v2");
  });

  it("resolves v3 field jacket from E12", () => {
    const active = resolveActiveAppearance(monicaHistory(), { episode: "S01E12" });
    expect(active.wardrobeVersion).toBe("field-jacket-v3");
  });

  it("resolves the latest version with no query (now)", () => {
    expect(resolveActiveAppearance(monicaHistory(), {}).versionLabel).toBe("v3");
  });

  it("resolves v1 when the query predates every effective point", () => {
    const history = monicaHistory();
    history.versions[0] = { ...history.versions[0]!, effectiveEpisode: "S01E03" };
    expect(resolveActiveAppearance(history, { episode: "S01E02" }).versionLabel).toBe("v1");
  });

  it("throws on an empty history", () => {
    expect(() =>
      resolveActiveAppearance(
        { characterId: MONICA, baseIdentityMasterId: "M", versions: [] },
        { episode: "S01E01" },
      ),
    ).toThrow(WardrobeCheckError);
  });

  it("throws on a malformed episode code", () => {
    expect(() => resolveActiveAppearance(monicaHistory(), { episode: "ep9" })).toThrow(
      /S<season>E<episode>/,
    );
  });

  it("resolves by effectiveTime when the query carries only a time", () => {
    const history: AppearanceHistoryInput = {
      characterId: MONICA,
      baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
      versions: [
        {
          versionLabel: "day-look",
          hairVersion: "long-braids-v1",
          wardrobeVersion: "business-blue-v1",
          baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
          effectiveTime: "2026-08-01T00:00:00Z",
        },
        {
          versionLabel: "evening-look",
          hairVersion: "updo-v2",
          wardrobeVersion: "red-evening-gown-v1",
          baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
          effectiveTime: "2026-08-28T18:00:00Z",
        },
      ],
    };
    expect(resolveActiveAppearance(history, { time: "2026-08-28T12:00:00Z" }).versionLabel).toBe(
      "day-look",
    );
    expect(resolveActiveAppearance(history, { time: "2026-08-28T20:00:00Z" }).versionLabel).toBe(
      "evening-look",
    );
  });

  it("does not skip an episode-gated version when only a time query is given", () => {
    // The E12 wardrobe change is episode-gated; a time-only query must not
    // advance past versions whose effective point it cannot compare.
    const active = resolveActiveAppearance(monicaHistory(), {
      time: "2099-01-01T00:00:00Z",
    });
    expect(active.versionLabel).toBe("v1");
  });
});

describe("checkAppearance — planning gate (active version vs shot spec)", () => {
  it("passes when the shot spec pins the active hair/wardrobe", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { hairVersion: "short-bob-v2", wardrobeVersion: "business-blue-v1" },
    });
    expect(result.status).toBe("PASS");
    expect(result.failures).toEqual([]);
    expect(result.activeVersionLabel).toBe("v2");
    expect(result.activeHairVersion).toBe("short-bob-v2");
  });

  it("flags a WRONG-WARDROBE fixture: braids required in E10 after the E09 haircut", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { hairVersion: "long-braids-v1", wardrobeVersion: "business-blue-v1" },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe("HAIR_MISMATCH");
    expect(result.failures[0]?.expected).toBe("long-braids-v1");
    expect(result.failures[0]?.actual).toBe("short-bob-v2");
    expect(result.failures[0]?.message).toContain("S01E10");
  });

  it("flags a stale wardrobe pin (field jacket required in E10, canon is business blue)", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { hairVersion: "short-bob-v2", wardrobeVersion: "field-jacket-v3" },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures[0]?.kind).toBe("WARDROBE_MISMATCH");
    expect(result.failures[0]?.expected).toBe("field-jacket-v3");
    expect(result.failures[0]?.actual).toBe("business-blue-v1");
  });

  it("passes the field-jacket pin at E12 where it IS canon", () => {
    const result = checkAppearance({
      shotId: "S01E12_SC01_SH02",
      characterId: MONICA,
      episode: "S01E12",
      appearanceHistory: monicaHistory(),
      requirements: { hairVersion: "short-bob-v2", wardrobeVersion: "field-jacket-v3" },
    });
    expect(result.status).toBe("PASS");
  });

  it("accumulates hair and wardrobe failures together", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { hairVersion: "long-braids-v1", wardrobeVersion: "field-jacket-v3" },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures.map((f) => f.kind).sort()).toEqual([
      "HAIR_MISMATCH",
      "WARDROBE_MISMATCH",
    ]);
  });

  it("skips the planning gate when the shot spec pins nothing", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: {},
    });
    expect(result.status).toBe("PASS");
    expect(result.activeVersionLabel).toBe("v2");
  });

  it("handles an empty appearance history without throwing", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: { characterId: MONICA, baseIdentityMasterId: "M", versions: [] },
      requirements: { hairVersion: "any" },
    });
    expect(result.activeVersionLabel).toBeNull();
    expect(result.status).toBe("PASS");
  });
});

describe("checkAppearance — observation gate (generated media)", () => {
  it("passes when the observation matches all requirements", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: {
        hairVersion: "short-bob-v2",
        wardrobeVersion: "business-blue-v1",
        requiredProps: ["briefcase"],
        forbiddenProps: ["umbrella"],
      },
      observation: {
        hairVersion: "short-bob-v2",
        wardrobeVersion: "business-blue-v1",
        props: ["briefcase", "coffee cup"],
      },
    });
    expect(result.status).toBe("PASS");
    expect(result.failures).toEqual([]);
  });

  it("flags a WRONG-WARDROBE observation (braids + wrong blazer in the generated media)", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: {
        hairVersion: "short-bob-v2",
        wardrobeVersion: "business-blue-v1",
      },
      observation: {
        hairVersion: "long-braids-v1",
        wardrobeVersion: "red-evening-gown-v1",
      },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures.map((f) => f.kind).sort()).toEqual([
      "HAIR_MISMATCH",
      "WARDROBE_MISMATCH",
    ]);
    expect(result.failures.find((f) => f.kind === "WARDROBE_MISMATCH")?.actual).toBe(
      "red-evening-gown-v1",
    );
  });

  it("flags a missing required prop", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { requiredProps: ["briefcase"] },
      observation: { props: ["coffee cup"] },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures[0]).toMatchObject({
      kind: "MISSING_PROP",
      expected: "briefcase",
      actual: null,
    });
  });

  it("flags a forbidden prop that leaked into the generated media", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: { forbiddenProps: ["umbrella"] },
      observation: { props: ["briefcase", "umbrella"] },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures[0]).toMatchObject({
      kind: "FORBIDDEN_PROP",
      expected: "absent: umbrella",
      actual: "umbrella",
    });
  });

  it("flags a wrong hair observation even without a history (standalone media check)", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      appearanceHistory: { characterId: MONICA, baseIdentityMasterId: "M", versions: [] },
      requirements: { hairVersion: "long-braids-v1" },
      observation: { hairVersion: "short-bob-v2" },
    });
    expect(result.status).toBe("FAIL");
    expect(result.failures[0]?.kind).toBe("HAIR_MISMATCH");
  });

  it("does not flag an unobserved dimension (hair not observed → no hair failure)", () => {
    const result = checkAppearance({
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      appearanceHistory: { characterId: MONICA, baseIdentityMasterId: "M", versions: [] },
      requirements: { hairVersion: "short-bob-v2" },
      observation: { wardrobeVersion: "business-blue-v1" },
    });
    expect(result.status).toBe("PASS");
  });
});

describe("checkShot — multi-character shot", () => {
  const HARRIS = "CHAR_HARRIS_COLE_002";

  it("checks every character and rolls the shot status up", () => {
    const harrisHistory: AppearanceHistoryInput = {
      characterId: HARRIS,
      baseIdentityMasterId: "ASSET_HARRIS_IDENTITY_MASTER_V1",
      versions: [
        {
          versionLabel: "v1",
          hairVersion: "buzz-cut-v1",
          wardrobeVersion: "detective-coat-v1",
          baseIdentityMasterId: "ASSET_HARRIS_IDENTITY_MASTER_V1",
          effectiveEpisode: "S01E01",
        },
      ],
    };
    const results = checkShot({
      shotId: "S01E10_SC04_SH07",
      episode: "S01E10",
      characters: [
        {
          characterId: MONICA,
          appearanceHistory: monicaHistory(),
          requirements: { hairVersion: "short-bob-v2", wardrobeVersion: "business-blue-v1" },
          observation: { hairVersion: "long-braids-v1", wardrobeVersion: "business-blue-v1" },
        },
        {
          characterId: HARRIS,
          appearanceHistory: harrisHistory,
          requirements: { hairVersion: "buzz-cut-v1", wardrobeVersion: "detective-coat-v1" },
          observation: { hairVersion: "buzz-cut-v1", wardrobeVersion: "detective-coat-v1" },
        },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.characterId).toBe(MONICA);
    expect(results[0]?.status).toBe("FAIL");
    expect(results[1]?.status).toBe("PASS");
    expect(overallStatus(results)).toBe("FAIL");
  });

  it("rolls PASS when every character passes", () => {
    const results = checkShot({
      shotId: "S01E10_SC04_SH07",
      episode: "S01E10",
      characters: [
        {
          characterId: MONICA,
          appearanceHistory: monicaHistory(),
          requirements: { hairVersion: "short-bob-v2" },
        },
      ],
    });
    expect(overallStatus(results)).toBe("PASS");
  });
});

describe("input validation", () => {
  function baseInput(): ShotAppearanceCheckInput {
    return {
      shotId: "S01E10_SC04_SH07",
      characterId: MONICA,
      episode: "S01E10",
      appearanceHistory: monicaHistory(),
      requirements: {},
    };
  }

  it("rejects an empty shotId", () => {
    expect(() => checkAppearance({ ...baseInput(), shotId: "" })).toThrow(/shotId/);
  });

  it("rejects an empty characterId", () => {
    expect(() => checkAppearance({ ...baseInput(), characterId: "" })).toThrow(
      /characterId/,
    );
  });

  it("rejects an empty shotId in checkShot", () => {
    expect(() => checkShot({ shotId: "", characters: [] })).toThrow(/shotId/);
  });
});