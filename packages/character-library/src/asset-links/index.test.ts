import { describe, expect, it } from "vitest";

import {
  AssetLinkError,
  InMemoryAssetManifest,
  refreshAssetLink,
  refreshStaleLink,
  requireCanonicalLink,
  resolveAssetLink,
  resolveReferencePlanAsset,
  toReferencePlanAsset,
  validateRefreshedLink,
  verbatimTriplet,
  type AssetLinkRecord,
  type GhlMediaRecord,
  type GhlMediaStore,
} from "./index";

/**
 * CHAR-014 acceptance:
 * - canonical GHL file ID + URL + checksum resolved verbatim in downstream
 *   reference plans (spec §9);
 * - stale-link refresh via manifest;
 * - local-cache-removal resolution against a mocked GHL
 *   (spec §35 gate 13: "resolve the canonical asset via DB after local cache
 *   removal").
 */

const CANONICAL = {
  ghlFileId: "ghl-file-0001",
  ghlUrl: "https://services.leadconnectorhq.com/media/ghl-file-0001/canon.png",
  sha256: "a".repeat(64),
} as const;

function makeRecord(overrides: Partial<AssetLinkRecord> = {}): AssetLinkRecord {
  return {
    assetId: "IDENT_ASSET_MONICA_V1_0001",
    characterId: "CHAR_MONICA",
    identityVersion: "v1",
    ghlFileId: CANONICAL.ghlFileId,
    ghlUrl: CANONICAL.ghlUrl,
    sha256: CANONICAL.sha256,
    localCachePath: null,
    approvalState: "CANONICAL",
    canonical: true,
    ...overrides,
  };
}

/** In-memory mock of the read-only GHL media store (the GHL lane's seam). */
function mockGhl(
  files: Record<string, GhlMediaRecord | null> = {
    [CANONICAL.ghlFileId]: {
      fileId: CANONICAL.ghlFileId,
      url: CANONICAL.ghlUrl,
      sha256: CANONICAL.sha256,
      folderId: "folder-canon",
      sizeBytes: 1024,
      dimensions: { width: 1024, height: 1024 },
    },
  },
): GhlMediaStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getMedia(fileId) {
      calls.push(fileId);
      return files[fileId] ?? null;
    },
  };
}

describe("requireCanonicalLink (verbatim triplet)", () => {
  it("returns the triplet verbatim — no rewriting of file ID, URL or checksum", () => {
    const link = requireCanonicalLink(makeRecord());
    expect(link).toEqual({
      ghlFileId: CANONICAL.ghlFileId,
      ghlUrl: CANONICAL.ghlUrl,
      sha256: CANONICAL.sha256,
    });
  });

  it("throws on missing file ID / URL / checksum — never a partial triplet", () => {
    expect(() => requireCanonicalLink(makeRecord({ ghlFileId: null }))).toThrow(
      AssetLinkError,
    );
    expect(() => requireCanonicalLink(makeRecord({ ghlUrl: null }))).toThrow(
      AssetLinkError,
    );
    expect(() => requireCanonicalLink(makeRecord({ sha256: null }))).toThrow(
      AssetLinkError,
    );
  });

  it("rejects non-hex or uppercase checksums (spec: lowercase sha256)", () => {
    expect(() =>
      requireCanonicalLink(makeRecord({ sha256: "ZZ".repeat(32) })),
    ).toThrow(AssetLinkError);
    expect(() =>
      requireCanonicalLink(makeRecord({ sha256: "A".repeat(64) })),
    ).toThrow(AssetLinkError);
  });
});

describe("resolveAssetLink — local cache removal fallback (mocked GHL)", () => {
  it("resolves via durable DB record after local cache removal; GHL triplet verbatim", async () => {
    // Record previously cached locally; the cache has since been removed.
    const record = makeRecord({
      localCachePath: "/tmp/cache/monica_v1.png",
    });
    const ghl = mockGhl(); // even with GHL reachable, the DB record wins

    const resolution = await resolveAssetLink(record, new InMemoryAssetManifest(), ghl);

    expect(resolution.source).toBe("manifest");
    expect(resolution.localCachePath).toBeNull();
    expect(resolution.refreshed).toBe(false);
    expect(resolution.link).toEqual(CANONICAL);
    expect(ghl.calls).toEqual([]); // no network round-trip needed
  });

  it("local-cache hit only when path AND checksum match the record", async () => {
    const record = makeRecord({ localCachePath: "/tmp/cache/monica_v1.png" });
    const manifest = new InMemoryAssetManifest();

    const hit = await resolveAssetLink(record, manifest, mockGhl(), {
      localCache: { path: "/tmp/cache/monica_v1.png", sha256: CANONICAL.sha256 },
    });
    expect(hit.source).toBe("local-cache");
    expect(hit.localCachePath).toBe("/tmp/cache/monica_v1.png");
    expect(hit.link).toEqual(CANONICAL);

    const checksumMiss = await resolveAssetLink(record, manifest, mockGhl(), {
      localCache: { path: "/tmp/cache/monica_v1.png", sha256: "b".repeat(64) },
    });
    expect(checksumMiss.source).toBe("manifest");

    const pathMiss = await resolveAssetLink(record, manifest, mockGhl(), {
      localCache: { path: "/tmp/cache/other.png", sha256: CANONICAL.sha256 },
    });
    expect(pathMiss.source).toBe("manifest");
  });

  it("stale record (missing URL) + refreshOnStale refreshes via manifest against mocked GHL", async () => {
    const manifest = new InMemoryAssetManifest([
      {
        assetId: "IDENT_ASSET_MONICA_V1_0002",
        link: {
          ghlFileId: "ghl-file-0002",
          ghlUrl: "https://old.example.invalid/stale.png",
          sha256: "c".repeat(64),
          localCachePath: null,
        },
      },
    ]);
    const refreshedUrl =
      "https://services.leadconnectorhq.com/media/ghl-file-0002/fresh.png";
    const ghl = mockGhl({
      "ghl-file-0002": {
        fileId: "ghl-file-0002",
        url: refreshedUrl,
        sha256: "d".repeat(64),
        folderId: null,
        sizeBytes: 2048,
        dimensions: null,
      },
    });

    const resolution = await resolveAssetLink(
      makeRecord({
        assetId: "IDENT_ASSET_MONICA_V1_0002",
        ghlUrl: null,
        sha256: null,
      }),
      manifest,
      ghl,
      { refreshOnStale: true },
    );

    expect(resolution.source).toBe("ghl-refresh");
    expect(resolution.refreshed).toBe(true);
    expect(resolution.link).toEqual({
      ghlFileId: "ghl-file-0002",
      ghlUrl: refreshedUrl,
      sha256: "d".repeat(64),
    });
    // Refresh persisted back to the manifest.
    const saved = await manifest.load("IDENT_ASSET_MONICA_V1_0002");
    expect(saved?.link.ghlUrl).toBe(refreshedUrl);
  });

  it("throws without durable linkage and no refresh allowed", async () => {
    const record = makeRecord({
      ghlFileId: null,
      ghlUrl: null,
      sha256: null,
    });
    await expect(
      resolveAssetLink(record, new InMemoryAssetManifest(), mockGhl()),
    ).rejects.toThrow(AssetLinkError);
  });

  it("durable record with refreshOnStale resolves from manifest without a GHL round-trip", async () => {
    // refreshOnStale permits a refresh when needed; a complete durable record
    // still short-circuits — no speculative network call.
    const ghl = mockGhl();
    const resolution = await resolveAssetLink(
      makeRecord(),
      new InMemoryAssetManifest(),
      ghl,
      { refreshOnStale: true },
    );
    expect(resolution.source).toBe("manifest");
    expect(resolution.link).toEqual(CANONICAL);
    expect(ghl.calls).toEqual([]);
  });

  it("caller-flagged staleness (stale: true) forces a GHL refresh past a durable record", async () => {
    // Record looks complete, but a provider call just failed on its URL — the
    // caller flags it stale; resolution must NOT return the stale URL verbatim.
    const freshUrl =
      "https://services.leadconnectorhq.com/media/ghl-file-0001/reissued.png";
    const manifest = new InMemoryAssetManifest([
      {
        assetId: "IDENT_ASSET_MONICA_V1_0001",
        link: { ...CANONICAL, localCachePath: null },
      },
    ]);
    const ghl = mockGhl({
      [CANONICAL.ghlFileId]: {
        fileId: CANONICAL.ghlFileId,
        url: freshUrl,
        sha256: "1".repeat(64),
        folderId: "folder-canon",
        sizeBytes: 4096,
        dimensions: null,
      },
    });

    const resolution = await resolveAssetLink(
      makeRecord({ localCachePath: "/tmp/cache/monica_v1.png" }),
      manifest,
      ghl,
      { stale: true },
    );

    expect(resolution.source).toBe("ghl-refresh");
    expect(resolution.refreshed).toBe(true);
    expect(resolution.link).toEqual({
      ghlFileId: CANONICAL.ghlFileId,
      ghlUrl: freshUrl,
      sha256: "1".repeat(64),
    });
    expect(ghl.calls).toEqual([CANONICAL.ghlFileId]);
    const saved = await manifest.load("IDENT_ASSET_MONICA_V1_0001");
    expect(saved?.link.ghlUrl).toBe(freshUrl);
  });

  it("stale: true with no manifest entry surfaces the refresh error (never a stale triplet)", async () => {
    const ghl = mockGhl(); // no manifest entry -> refreshStaleLink throws
    await expect(
      resolveAssetLink(makeRecord(), new InMemoryAssetManifest(), ghl, {
        stale: true,
      }),
    ).rejects.toThrow(AssetLinkError);
  });
});

describe("refreshStaleLink — stale-link refresh via manifest", () => {
  it("re-reads GHL, validates, and persists the refreshed link", async () => {
    const freshUrl = "https://services.leadconnectorhq.com/media/ghl-file-0001/v2.png";
    const manifest = new InMemoryAssetManifest([
      {
        assetId: "IDENT_ASSET_MONICA_V1_0001",
        link: { ...CANONICAL, localCachePath: null },
      },
    ]);
    const ghl = mockGhl({
      [CANONICAL.ghlFileId]: {
        fileId: CANONICAL.ghlFileId,
        url: freshUrl,
        sha256: "e".repeat(64),
        folderId: "folder-canon",
        sizeBytes: 4096,
        dimensions: { width: 1024, height: 1024 },
      },
    });

    const link = await refreshStaleLink(
      "IDENT_ASSET_MONICA_V1_0001",
      manifest,
      ghl,
    );
    expect(link.ghlUrl).toBe(freshUrl);
    expect(link.sha256).toBe("e".repeat(64));

    const saved = await manifest.load("IDENT_ASSET_MONICA_V1_0001");
    expect(saved?.link).toEqual({
      ghlFileId: CANONICAL.ghlFileId,
      ghlUrl: freshUrl,
      sha256: "e".repeat(64),
      localCachePath: null,
    });
  });

  it("refuses to refresh when GHL reports the file missing", async () => {
    const manifest = new InMemoryAssetManifest([
      {
        assetId: "IDENT_ASSET_MONICA_V1_0001",
        link: { ...CANONICAL, localCachePath: null },
      },
    ]);
    const ghl = mockGhl({ [CANONICAL.ghlFileId]: null });

    await expect(
      refreshStaleLink("IDENT_ASSET_MONICA_V1_0001", manifest, ghl),
    ).rejects.toThrow(/missing/);
    // Manifest untouched by the failed refresh.
    const saved = await manifest.load("IDENT_ASSET_MONICA_V1_0001");
    expect(saved?.link.ghlUrl).toBe(CANONICAL.ghlUrl);
  });

  it("throws when the manifest has no entry or the entry lacks a file ID", async () => {
    await expect(
      refreshStaleLink("IDENT_ASSET_MISSING", new InMemoryAssetManifest(), mockGhl()),
    ).rejects.toThrow(AssetLinkError);
  });

  it("refreshAssetLink returns an updated record without fabricating links", async () => {
    const freshUrl = "https://services.leadconnectorhq.com/media/ghl-file-0001/v3.png";
    const ghl = mockGhl({
      [CANONICAL.ghlFileId]: {
        fileId: CANONICAL.ghlFileId,
        url: freshUrl,
        sha256: "f".repeat(64),
        folderId: null,
        sizeBytes: null,
        dimensions: null,
      },
    });
    const updated = await refreshAssetLink(makeRecord(), new InMemoryAssetManifest(), ghl);
    expect(updated.ghlUrl).toBe(freshUrl);
    expect(updated.sha256).toBe("f".repeat(64));
    expect(updated.characterId).toBe("CHAR_MONICA");

    const gone = mockGhl({});
    await expect(
      refreshAssetLink(makeRecord(), new InMemoryAssetManifest(), gone),
    ).rejects.toThrow(AssetLinkError);
  });
});

describe("downstream reference plan handoff", () => {
  it("reference-plan entry carries the triplet verbatim (spec §9)", () => {
    const entry = toReferencePlanAsset(makeRecord());
    expect(entry.ghlFileId).toBe(CANONICAL.ghlFileId);
    expect(entry.ghlUrl).toBe(CANONICAL.ghlUrl);
    expect(entry.sha256).toBe(CANONICAL.sha256);
    expect(entry.characterId).toBe("CHAR_MONICA");
    expect(entry.identityVersion).toBe("v1");
    expect(entry.resolvedFrom).toBe("manifest");
  });

  it("resolveReferencePlanAsset resolves with local-cache fallback metadata", async () => {
    const record = makeRecord({ localCachePath: "/tmp/cache/monica_v1.png" });
    const manifest = new InMemoryAssetManifest();

    const fromCache = await resolveReferencePlanAsset(record, manifest, mockGhl(), {
      localCache: { path: "/tmp/cache/monica_v1.png", sha256: CANONICAL.sha256 },
    });
    expect(fromCache.resolvedFrom).toBe("local-cache");
    expect(fromCache.ghlUrl).toBe(CANONICAL.ghlUrl);

    const fromDb = await resolveReferencePlanAsset(record, manifest, mockGhl());
    expect(fromDb.resolvedFrom).toBe("manifest");
    expect(fromDb.ghlFileId).toBe(CANONICAL.ghlFileId);
    expect(fromDb.sha256).toBe(CANONICAL.sha256);
  });

  it("verbatimTriplet returns the exact resolved link", async () => {
    const resolution = await resolveAssetLink(
      makeRecord(),
      new InMemoryAssetManifest(),
      mockGhl(),
    );
    expect(verbatimTriplet(resolution)).toEqual(CANONICAL);
  });
});

describe("validateRefreshedLink", () => {
  it("accepts a valid GHL record and rejects corrupt ones", () => {
    expect(
      validateRefreshedLink({
        fileId: "ghl-file-9",
        url: "https://example.test/x.png",
        sha256: "0".repeat(64),
      }),
    ).toEqual({
      ghlFileId: "ghl-file-9",
      ghlUrl: "https://example.test/x.png",
      sha256: "0".repeat(64),
    });
    expect(() =>
      validateRefreshedLink({ fileId: "ghl-file-9", url: "", sha256: "0".repeat(64) }),
    ).toThrow(AssetLinkError);
    expect(() =>
      validateRefreshedLink({
        fileId: "ghl-file-9",
        url: "https://example.test/x.png",
        sha256: "nope",
      }),
    ).toThrow(AssetLinkError);
  });
});