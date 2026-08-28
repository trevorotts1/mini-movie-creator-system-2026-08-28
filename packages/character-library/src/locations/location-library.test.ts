import { describe, expect, it } from "vitest";

import {
  ASSET_STATES,
  ASSET_TRANSITIONS,
  DAY_NIGHT_STATES,
  LOCATION_ANGLES,
  LocationLibraryError,
  REQUIRED_ANGLE_STATES,
  compareContinuityPoints,
  createLocationLibrary,
  findVersionApprovalGaps,
  isAtOrAfter,
  isVersionFullyApproved,
  parseLocationMaster,
  safeParseLocationMaster,
} from "./index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function media(sha: string = SHA_A) {
  return {
    ghlFileId: "ghl-file-1",
    ghlUrl: `https://media.example.com/${sha.slice(0, 8)}.png`,
    sha256: sha,
  };
}

/** Build a version with all 6 angle x lighting assets approved. */
function fullyApprovedAssets(version: ReturnType<ReturnType<typeof createLocationLibrary>["addVersion"]>) {
  return version.assets.map((asset, index) => {
    lib.attachMedia("LOC_MONICA_APT_001", version.versionId, asset.assetId, media(index % 2 === 0 ? SHA_A : SHA_B));
    return lib.setAssetState("LOC_MONICA_APT_001", version.versionId, asset.assetId, "REVIEW");
  });
}

let assetCounter = 0;

const lib = createLocationLibrary();

/** Add all 6 angle x lighting assets to a version and walk them to APPROVED. */
function fillAndApproveAssets(
  library: ReturnType<typeof createLocationLibrary>,
  locationId: string,
  versionId: string,
  sha: string = SHA_A,
) {
  for (const angle of LOCATION_ANGLES) {
    for (const dayNight of DAY_NIGHT_STATES) {
      const assetId = `AST_${locationId}_${angle}_${dayNight}`.toUpperCase();
      library.addAngleAsset(locationId, versionId, { assetId, angle, dayNight });
      library.attachMedia(locationId, versionId, assetId, media(sha));
      library.setAssetState(locationId, versionId, assetId, "REVIEW");
      library.setAssetState(locationId, versionId, assetId, "APPROVED");
    }
  }
  return library.approveVersion(locationId, versionId);
}

function seedApprovedMaster(effectiveFrom = { season: 1, episode: 1 }) {
  assetCounter += 1;
  const locationId = `LOC_SEED_${String(assetCounter).padStart(3, "0")}`;
  lib.createMaster({ locationId, displayName: `Seed ${assetCounter}`, effectiveFrom });
  const version = fillAndApproveAssets(lib, locationId, "v1");
  return { locationId, version };
}

describe("location schema constants", () => {
  it("requires exactly wide/medium/reverse angles", () => {
    expect(LOCATION_ANGLES).toEqual(["wide", "medium", "reverse"]);
  });

  it("requires exactly day/night states", () => {
    expect(DAY_NIGHT_STATES).toEqual(["day", "night"]);
  });

  it("covers all 6 angle x lighting combos", () => {
    expect(REQUIRED_ANGLE_STATES).toHaveLength(6);
    for (const angle of LOCATION_ANGLES) {
      for (const dayNight of DAY_NIGHT_STATES) {
        expect(REQUIRED_ANGLE_STATES).toContainEqual({ angle, dayNight });
      }
    }
  });

  it("REJECTED and RETIRED are terminal asset states", () => {
    expect(ASSET_TRANSITIONS.REJECTED).toEqual([]);
    expect(ASSET_TRANSITIONS.RETIRED).toEqual([]);
    expect(ASSET_STATES).toContain("REJECTED");
  });
});

describe("continuity point helpers", () => {
  it("orders season before episode", () => {
    expect(compareContinuityPoints({ season: 1, episode: 9 }, { season: 2, episode: 1 })).toBe(-1);
    expect(compareContinuityPoints({ season: 1, episode: 8 }, { season: 1, episode: 9 })).toBe(-1);
    expect(compareContinuityPoints({ season: 1, episode: 9 }, { season: 1, episode: 9 })).toBe(0);
  });

  it("isAtOrAfter is inclusive", () => {
    expect(isAtOrAfter({ season: 1, episode: 9 }, { season: 1, episode: 9 })).toBe(true);
    expect(isAtOrAfter({ season: 1, episode: 8 }, { season: 1, episode: 9 })).toBe(false);
  });
});

describe("master creation", () => {
  it("creates a master with DRAFT v1 canon from S1E1 by default", () => {
    const created = lib.createMaster({
      locationId: "LOC_MONICA_APT_001",
      displayName: "Monica's Apartment",
      description: "Open-plan loft, city-facing windows",
    });
    expect(created.locationId).toBe("LOC_MONICA_APT_001");
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]?.state).toBe("DRAFT");
    expect(created.versions[0]?.effectiveFrom).toEqual({ season: 1, episode: 1 });
  });

  it("rejects display-name-keyed or malformed IDs", () => {
    expect(() => lib.createMaster({ locationId: "Monica's Apartment", displayName: "x" })).toThrow(
      LocationLibraryError,
    );
    expect(() => lib.createMaster({ locationId: "LOC_bad-id_001", displayName: "x" })).toThrow(
      LocationLibraryError,
    );
    expect(() => lib.createMaster({ locationId: "CHAR_MONICA_001", displayName: "x" })).toThrow(
      LocationLibraryError,
    );
  });

  it("rejects duplicate masters", () => {
    expect(() =>
      lib.createMaster({ locationId: "LOC_MONICA_APT_001", displayName: "dup" }),
    ).toThrow(LocationLibraryError);
  });

  it("rejects invalid effectiveFrom", () => {
    const fresh = createLocationLibrary();
    expect(() =>
      fresh.createMaster({
        locationId: "LOC_OK_001",
        displayName: "ok",
        effectiveFrom: { season: 0, episode: 1 },
      }),
    ).toThrow(LocationLibraryError);
  });
});

describe("angle asset lifecycle", () => {
  it("adds one asset per angle x lighting combo, no duplicates", () => {
    const version = lib.requireMaster("LOC_MONICA_APT_001").versions[0]!;
    const added = lib.addAngleAsset("LOC_MONICA_APT_001", version.versionId, {
      assetId: "AST_APT_WIDE_DAY",
      angle: "wide",
      dayNight: "day",
    });
    expect(added.state).toBe("DRAFT");
    expect(added.media).toBeNull();
    expect(() =>
      lib.addAngleAsset("LOC_MONICA_APT_001", version.versionId, {
        assetId: "AST_APT_WIDE_DAY_2",
        angle: "wide",
        dayNight: "day",
      }),
    ).toThrow(LocationLibraryError);
  });

  it("blocks approval until every angle x lighting combo has an approved asset", () => {
    const version = lib.requireMaster("LOC_MONICA_APT_001").versions[0]!;
    const gaps = findVersionApprovalGaps(version);
    expect(gaps.length).toBeGreaterThan(0);
    expect(() => lib.approveVersion("LOC_MONICA_APT_001", version.versionId)).toThrow(
      LocationLibraryError,
    );
  });

  it("requires media before an asset can be APPROVED", () => {
    const version = lib.requireMaster("LOC_MONICA_APT_001").versions[0]!;
    lib.addAngleAsset("LOC_MONICA_APT_001", version.versionId, {
      assetId: "AST_APT_WIDE_NIGHT",
      angle: "wide",
      dayNight: "night",
    });
    const assetId = "AST_APT_WIDE_NIGHT";
    lib.setAssetState("LOC_MONICA_APT_001", version.versionId, assetId, "REVIEW");
    expect(() =>
      lib.setAssetState("LOC_MONICA_APT_001", version.versionId, assetId, "APPROVED"),
    ).toThrow(/MEDIA_REQUIRED/);
  });

  it("rejects invalid state transitions", () => {
    const version = lib.requireMaster("LOC_MONICA_APT_001").versions[0]!;
    lib.addAngleAsset("LOC_MONICA_APT_001", version.versionId, {
      assetId: "AST_APT_MED_DAY",
      angle: "medium",
      dayNight: "day",
    });
    expect(() =>
      lib.setAssetState("LOC_MONICA_APT_001", version.versionId, "AST_APT_MED_DAY", "CANONICAL"),
    ).toThrow(/INVALID_TRANSITION/);
  });

  it("validates sha256 + URL shape on media", () => {
    const version = lib.requireMaster("LOC_MONICA_APT_001").versions[0]!;
    lib.addAngleAsset("LOC_MONICA_APT_001", version.versionId, {
      assetId: "AST_APT_MED_NIGHT",
      angle: "medium",
      dayNight: "night",
    });
    expect(() =>
      lib.attachMedia("LOC_MONICA_APT_001", version.versionId, "AST_APT_MED_NIGHT", {
        ghlFileId: "f",
        ghlUrl: "not-a-url",
        sha256: SHA_B,
      }),
    ).toThrow(/ghlUrl/);
    expect(() =>
      lib.attachMedia("LOC_MONICA_APT_001", version.versionId, "AST_APT_MED_NIGHT", {
        ghlFileId: "f",
        ghlUrl: "https://ok.example.com/x.png",
        sha256: "tooshort",
      }),
    ).toThrow(/sha256/);
  });
});

describe("version approval + continuity resolution", () => {
  it("approves a fully covered version", () => {
    const fresh = createLocationLibrary();
    fresh.createMaster({
      locationId: "LOC_FULLAPPR_001",
      displayName: "full coverage",
      effectiveFrom: { season: 1, episode: 1 },
    });
    const approved = fillAndApproveAssets(fresh, "LOC_FULLAPPR_001", "v1");
    expect(approved.state).toBe("APPROVED");
    expect(isVersionFullyApproved(approved)).toBe(true);
  });

  it("refuses approval with any missing combo", () => {
    const fresh = createLocationLibrary();
    fresh.createMaster({
      locationId: "LOC_PARTIAL_001",
      displayName: "partial",
      effectiveFrom: { season: 1, episode: 1 },
    });
    // Fill only wide + medium; leave reverse angles missing entirely.
    for (const angle of ["wide", "medium"] as const) {
      for (const dayNight of DAY_NIGHT_STATES) {
        const assetId = `AST_PARTIAL_${angle}_${dayNight}`.toUpperCase();
        fresh.addAngleAsset("LOC_PARTIAL_001", "v1", { assetId, angle, dayNight });
        fresh.attachMedia("LOC_PARTIAL_001", "v1", assetId, media());
        fresh.setAssetState("LOC_PARTIAL_001", "v1", assetId, "REVIEW");
        fresh.setAssetState("LOC_PARTIAL_001", "v1", assetId, "APPROVED");
      }
    }
    const version = fresh.requireMaster("LOC_PARTIAL_001").versions[0]!;
    expect(() => fresh.approveVersion("LOC_PARTIAL_001", version.versionId)).toThrow(
      /reverse/,
    );
  });

  it("resolves the canon version at an episode continuity point", () => {
    const { locationId } = seedApprovedMaster({ season: 1, episode: 1 });
    expect(lib.resolveVersion(locationId, { season: 1, episode: 5 }).versionId).toBe("v1");
    expect(lib.resolveVersion(locationId, { season: 3, episode: 12 }).versionId).toBe("v1");
  });

  it("new version takes over from its effectiveFrom; history stays intact", () => {
    const { locationId } = seedApprovedMaster({ season: 1, episode: 1 });
    lib.addVersion({
      locationId,
      versionId: "v2",
      effectiveFrom: { season: 1, episode: 9 },
      description: "apartment renovated",
    });
    const v2 = fillAndApproveAssets(lib, locationId, "v2", SHA_B);
    // Historical episode keeps v1.
    expect(lib.resolveVersion(locationId, { season: 1, episode: 8 }).versionId).toBe("v1");
    // Boundary episode resolves v2 (inclusive).
    expect(lib.resolveVersion(locationId, { season: 1, episode: 9 }).versionId).toBe("v2");
    expect(lib.resolveVersion(locationId, { season: 2, episode: 1 }).versionId).toBe("v2");
    // v1 object untouched.
    const v1 = lib.requireMaster(locationId).versions.find((v) => v.versionId === "v1")!;
    expect(v1.state).toBe("APPROVED");
  });

  it("rejects versions whose effectiveFrom is before the latest", () => {
    const { locationId } = seedApprovedMaster({ season: 1, episode: 1 });
    lib.addVersion({ locationId, versionId: "v2", effectiveFrom: { season: 2, episode: 1 } });
    expect(() =>
      lib.addVersion({ locationId, versionId: "v3", effectiveFrom: { season: 1, episode: 9 } }),
    ).toThrow(/before the latest/);
  });

  it("rejects duplicate effectiveFrom points", () => {
    const { locationId } = seedApprovedMaster({ season: 1, episode: 1 });
    expect(() =>
      lib.addVersion({ locationId, versionId: "v2", effectiveFrom: { season: 1, episode: 1 } }),
    ).toThrow(/S1E1/);
  });

  it("throws NO_ACTIVE_VERSION before any approval exists", () => {
    const fresh = createLocationLibrary();
    fresh.createMaster({ locationId: "LOC_NODRAFT_001", displayName: "x" });
    expect(() =>
      fresh.resolveVersion("LOC_NODRAFT_001", { season: 1, episode: 1 }),
    ).toThrow(/NO_ACTIVE_VERSION/);
    expect(() => fresh.resolveVersion("LOC_MISSING_001", { season: 1, episode: 1 })).toThrow(
      /MASTER_NOT_FOUND/,
    );
  });

  it("retired versions stop resolving once superseded or alone", () => {
    const { locationId } = seedApprovedMaster();
    lib.retireVersion(locationId, "v1");
    expect(() => lib.resolveVersion(locationId, { season: 1, episode: 1 })).toThrow(
      /NO_ACTIVE_VERSION/,
    );
    expect(() => lib.retireVersion(locationId, "v1")).toThrow(/INVALID_TRANSITION/);
  });
});

describe("resolveAsset", () => {
  it("resolves the exact angle x lighting asset at the continuity point", () => {
    const { locationId } = seedApprovedMaster();
    const wide = lib.resolveAsset(locationId, { season: 1, episode: 3 }, "wide", "day");
    const reverse = lib.resolveAsset(locationId, { season: 1, episode: 3 }, "reverse", "night");
    expect(wide.angle).toBe("wide");
    expect(wide.dayNight).toBe("day");
    expect(reverse.angle).toBe("reverse");
    expect(reverse.dayNight).toBe("night");
    expect(wide.media?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("follows version transitions at the continuity point", () => {
    const { locationId } = seedApprovedMaster({ season: 1, episode: 1 });
    lib.addVersion({
      locationId,
      versionId: "v2",
      effectiveFrom: { season: 1, episode: 9 },
      description: "repainted walls",
    });
    const v2 = fillAndApproveAssets(lib, locationId, "v2", SHA_B);
    const before = lib.resolveAsset(locationId, { season: 1, episode: 8 }, "wide", "day");
    const after = lib.resolveAsset(locationId, { season: 1, episode: 9 }, "wide", "day");
    expect(before.media?.sha256).not.toBe(after.media?.sha256);
    expect(after.media?.sha256).toBe(SHA_B);
  });

  it("rejects invalid angle/dayNight inputs", () => {
    const { locationId } = seedApprovedMaster();
    expect(() =>
      lib.resolveAsset(locationId, { season: 1, episode: 1 }, "closeup" as never, "day"),
    ).toThrow(LocationLibraryError);
    expect(() =>
      lib.resolveAsset(locationId, { season: 1, episode: 1 }, "wide", "dusk" as never),
    ).toThrow(LocationLibraryError);
  });
});

describe("parse helpers", () => {
  it("round-trips a valid master through parseLocationMaster", () => {
    const { locationId } = seedApprovedMaster();
    const master = lib.requireMaster(locationId);
    expect(parseLocationMaster(JSON.parse(JSON.stringify(master))).locationId).toBe(locationId);
    expect(safeParseLocationMaster({ garbage: true })).toBeNull();
    expect(safeParseLocationMaster(master)).not.toBeNull();
  });
});