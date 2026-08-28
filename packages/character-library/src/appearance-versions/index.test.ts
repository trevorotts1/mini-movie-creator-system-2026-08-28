/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  addAppearanceVersion,
  AppearanceVersionError,
  createAppearanceHistory,
  latestAppearanceVersion,
  resolveAppearanceVersion,
  resolveAppearanceVersionForEpisode,
  type AppearanceHistory,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";

/** Monica per spec §9: v1 long braids E01–E08, v2 short hair from E09. */
function monicaHistory(): AppearanceHistory {
  const history = createAppearanceHistory(MONICA, "ASSET_MONICA_IDENTITY_MASTER_V1", {
    initialHairVersion: "long-braids-v1",
    initialWardrobeVersion: "business-blue-v1",
  });
  addAppearanceVersion(history, {
    hairVersion: "short-bob-v2",
    wardrobeVersion: "business-blue-v1",
    effectiveEpisode: "S01E09",
    changeNote: "cut the braids — short hair from E09",
  });
  return history;
}

describe("createAppearanceHistory", () => {
  it("seeds v1 with the original hair/wardrobe and the base identity master", () => {
    const history = monicaHistory();
    expect(history.characterId).toBe(MONICA);
    expect(history.baseIdentityMasterId).toBe("ASSET_MONICA_IDENTITY_MASTER_V1");
    expect(history.versions).toHaveLength(2);
    expect(history.versions[0]).toMatchObject({
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
      state: "DRAFT",
    });
    expect(history.versions[1]?.versionLabel).toBe("v2");
  });

  it("rejects an empty characterId", () => {
    expect(() =>
      createAppearanceHistory("", "ASSET_X", {
        initialHairVersion: "h",
        initialWardrobeVersion: "w",
      }),
    ).toThrow(AppearanceVersionError);
  });
});

describe("addAppearanceVersion", () => {
  it("creates a NEW version on a hair/wardrobe change with an effective episode", () => {
    const history = monicaHistory();
    const v2 = history.versions[1];
    expect(v2).toMatchObject({
      versionLabel: "v2",
      hairVersion: "short-bob-v2",
      effectiveEpisode: "S01E09",
      baseIdentityMasterId: "ASSET_MONICA_IDENTITY_MASTER_V1",
    });
  });

  it("never replaces the base identity master when appending", () => {
    const history = monicaHistory();
    addAppearanceVersion(history, {
      hairVersion: "pixie-v3",
      effectiveEpisode: "S02E01",
    });
    expect(history.baseIdentityMasterId).toBe("ASSET_MONICA_IDENTITY_MASTER_V1");
    for (const version of history.versions) {
      expect(version.baseIdentityMasterId).toBe("ASSET_MONICA_IDENTITY_MASTER_V1");
    }
    expect(history.versions.map((v) => v.versionLabel)).toEqual(["v1", "v2", "v3"]);
  });

  it("does not mutate the previous version when appending", () => {
    const history = monicaHistory();
    const v1Before = JSON.parse(JSON.stringify(history.versions[0]));
    addAppearanceVersion(history, {
      wardrobeVersion: "field-jacket-v2",
      effectiveEpisode: "S01E10",
    });
    expect(JSON.parse(JSON.stringify(history.versions[0]))).toEqual(v1Before);
    expect(history.versions[1]?.hairVersion).toBe("short-bob-v2");
  });

  it("requires an effective episode and/or effective time", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
    });
    expect(() =>
      addAppearanceVersion(history, { hairVersion: "h2" }),
    ).toThrow(/effective episode/i);
  });

  it("accepts an effective time alone", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
    });
    const v2 = addAppearanceVersion(history, {
      hairVersion: "h2",
      effectiveTime: "2026-08-28T00:00:00Z",
    });
    expect(v2.effectiveTime).toBe("2026-08-28T00:00:00Z");
  });

  it("rejects a change that alters neither hair nor wardrobe", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
    });
    expect(() =>
      addAppearanceVersion(history, { effectiveEpisode: "S01E02" }),
    ).toThrow(/must change/i);
  });

  it("carries forward unchanged dimensions from the latest version", () => {
    const history = monicaHistory();
    const v3 = addAppearanceVersion(history, {
      wardrobeVersion: "field-jacket-v2",
      effectiveEpisode: "S02E01",
    });
    expect(v3.hairVersion).toBe("short-bob-v2");
    expect(v3.wardrobeVersion).toBe("field-jacket-v2");
  });
});

describe("resolveAppearanceVersion — Monica canon-at-the-time", () => {
  it("resolves v1 braids for E01 through E08", () => {
    const history = monicaHistory();
    for (const episode of ["S01E01", "S01E02", "S01E07", "S01E08"]) {
      const resolved = resolveAppearanceVersion(history, { episode });
      expect(resolved.versionLabel).toBe("v1");
      expect(resolved.hairVersion).toBe("long-braids-v1");
    }
  });

  it("resolves v2 short from E09 onward", () => {
    const history = monicaHistory();
    for (const episode of ["S01E09", "S01E10", "S01E12", "S02E01"]) {
      const resolved = resolveAppearanceVersion(history, { episode });
      expect(resolved.versionLabel).toBe("v2");
      expect(resolved.hairVersion).toBe("short-bob-v2");
    }
  });

  it("resolves the latest version when queried without a point", () => {
    const history = monicaHistory();
    expect(resolveAppearanceVersion(history, {}).versionLabel).toBe("v2");
  });

  it("resolves v1 when the query predates every effective point", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
      initialEffective: { effectiveEpisode: "S01E01" },
    });
    addAppearanceVersion(history, { hairVersion: "h2", effectiveEpisode: "S01E09" });
    expect(resolveAppearanceVersion(history, { episode: "S01E04" }).hairVersion).toBe("h1");
    expect(resolveAppearanceVersion(history, { episode: "S01E09" }).hairVersion).toBe("h2");
  });

  it("handles a mid-season change (E05) correctly", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
    });
    addAppearanceVersion(history, { hairVersion: "h2", effectiveEpisode: "S01E05" });
    expect(resolveAppearanceVersionForEpisode(history, "S01E04").hairVersion).toBe("h1");
    expect(resolveAppearanceVersionForEpisode(history, "S01E05").hairVersion).toBe("h2");
  });

  it("applies time-only versions by instant", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
      initialEffective: { effectiveEpisode: "S01E01" },
    });
    addAppearanceVersion(history, {
      wardrobeVersion: "w2",
      effectiveTime: "2026-06-01T00:00:00Z",
    });
    expect(resolveAppearanceVersion(history, { time: "2026-05-01T00:00:00Z" }).wardrobeVersion).toBe("w1");
    expect(resolveAppearanceVersion(history, { time: "2026-07-01T00:00:00Z" }).wardrobeVersion).toBe("w2");
  });

  it("requires time in the query when the version is time-gated", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
      initialEffective: { effectiveEpisode: "S01E01" },
    });
    addAppearanceVersion(history, {
      wardrobeVersion: "w2",
      effectiveTime: "2026-06-01T00:00:00Z",
    });
    expect(resolveAppearanceVersion(history, { episode: "S01E09" }).wardrobeVersion).toBe("w1");
    expect(
      resolveAppearanceVersion(history, { episode: "S01E09", time: "2026-07-01T00:00:00Z" })
        .wardrobeVersion,
    ).toBe("w2");
  });

  it("requires both gates when a version carries both", () => {
    const history = createAppearanceHistory(MONICA, "M", {
      initialHairVersion: "h1",
      initialWardrobeVersion: "w1",
      initialEffective: { effectiveEpisode: "S01E01" },
    });
    addAppearanceVersion(history, {
      hairVersion: "h2",
      effectiveEpisode: "S01E09",
      effectiveTime: "2026-06-01T00:00:00Z",
    });
    expect(
      resolveAppearanceVersion(history, { episode: "S01E12" }).hairVersion,
    ).toBe("h1");
    expect(
      resolveAppearanceVersion(history, { time: "2026-07-01T00:00:00Z" }).hairVersion,
    ).toBe("h1");
    expect(
      resolveAppearanceVersion(history, {
        episode: "S01E12",
        time: "2026-07-01T00:00:00Z",
      }).hairVersion,
    ).toBe("h2");
  });

  it("throws on a malformed episode code", () => {
    const history = monicaHistory();
    expect(() => resolveAppearanceVersion(history, { episode: "episode 9" })).toThrow(
      /S<season>E<episode>/,
    );
  });
});

describe("latestAppearanceVersion", () => {
  it("returns the newest appended version", () => {
    const history = monicaHistory();
    expect(latestAppearanceVersion(history).versionLabel).toBe("v2");
  });
});