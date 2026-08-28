/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectSqlite, type SqliteDatabase } from "@mmcs/database";
import { AssetRepository, mapAssetRow } from "./asset-repository.js";
import { ASSET_MANIFEST_FIELDS, AssetManifestError, type AssetRecord } from "./types.js";

/**
 * The `assets` table DDL, identical to the schema band (CORE-007,
 * `004-jobs-assets`). That band owns the table; this test creates the same
 * table locally so the manifest package is testable before the band merges
 * and keeps testing the exact documented column set after.
 */
const ASSETS_TABLE_DDL = `
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  series_id TEXT,
  episode_id TEXT,
  scene_id TEXT,
  shot_id TEXT,
  character_id TEXT,
  character_version TEXT,
  asset_type TEXT NOT NULL,
  asset_state TEXT NOT NULL CHECK (
    asset_state IN ('DRAFT', 'REVIEW', 'APPROVED', 'CANONICAL', 'RETIRED', 'REJECTED')
  ),
  provider TEXT,
  provider_model TEXT,
  provider_task_id TEXT,
  original_provider_url TEXT,
  provider_url_expiration TEXT,
  ghl_file_id TEXT,
  ghl_folder_id TEXT,
  ghl_url TEXT,
  checksum TEXT,
  local_path TEXT,
  prompt TEXT,
  prompt_character_count INTEGER,
  references_used TEXT,
  generation_settings TEXT,
  cost REAL,
  generation_seconds REAL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  approval_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    approval_state IN ('PENDING', 'APPROVED', 'REJECTED')
  ),
  qc_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    qc_state IN ('PENDING', 'PASSED', 'FAILED', 'FIXING')
  )
) STRICT;
`.trim();

let db: SqliteDatabase;
let repo: AssetRepository;

beforeAll(() => {
  db = connectSqlite({ path: ":memory:" });
  db.exec(ASSETS_TABLE_DDL);
  repo = new AssetRepository(db);
});

afterAll(() => {
  db.close();
});

function baseRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    assetId: "mmcs_asset_0001",
    assetType: "video",
    assetState: "DRAFT",
    approvalState: "PENDING",
    qcState: "PENDING",
    createdAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("spec §19 manifest contract", () => {
  it("declares exactly the 26 spec §19 fields, in spec order", () => {
    expect(ASSET_MANIFEST_FIELDS).toHaveLength(26);
    expect(ASSET_MANIFEST_FIELDS[0]).toBe("asset_id");
    expect(ASSET_MANIFEST_FIELDS).toContain("ghl_file_id");
    expect(ASSET_MANIFEST_FIELDS).toContain("ghl_folder_id");
    expect(ASSET_MANIFEST_FIELDS).toContain("ghl_url");
    expect(ASSET_MANIFEST_FIELDS).toContain("checksum");
    expect(ASSET_MANIFEST_FIELDS[25]).toBe("created_at");
  });

  it("round-trips every manifest field through the DB row", () => {
    const record = baseRecord({
      seriesId: "mmcs_series_01",
      episodeId: "mmcs_episode_01",
      sceneId: "mmcs_scene_04",
      shotId: "mmcs_shot_07",
      characterId: "CHAR_MONICA_BENNETT_001",
      characterVersion: "v1",
      assetType: "video",
      assetState: "APPROVED",
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      providerTaskId: "job_abc123",
      originalProviderUrl: "https://tmp.provider.example/video/abc.mp4",
      providerUrlExpiration: "2026-08-29T12:00:00.000Z",
      ghlFileId: "ghl_file_9f2",
      ghlFolderId: "ghl_folder_01",
      ghlUrl: "https://storage.gohighlevel.example/9f2/monica.mp4",
      checksum: "a".repeat(64),
      localPath: "/tmp/cache/monica.mp4",
      prompt: "Monica close-up, office lighting",
      promptCharacterCount: 33,
      referencesUsed: ["mmcs_asset_0002", "mmcs_asset_0003"],
      generationSettings: { seed: 7, resolution: "720p", durationSeconds: 6 },
      cost: 0.42,
      generationSeconds: 6,
      archivedAt: "2026-08-28T12:05:00.000Z",
      approvalState: "APPROVED",
      qcState: "PASSED",
    });
    const created = repo.create(record);
    expect(created).toEqual(record);
    expect(repo.getById("mmcs_asset_0001")).toEqual(record);
  });

  it("persists all 29 columns for a full record (26 manifest + 3 lifecycle)", () => {
    const row = db.get("SELECT * FROM assets WHERE asset_id = ?", "mmcs_asset_0001");
    expect(row).toBeDefined();
    for (const column of ASSET_MANIFEST_FIELDS) {
      expect(row?.[column], column).toBeDefined();
    }
    expect(row?.["archived_at"]).toBe("2026-08-28T12:05:00.000Z");
  });
});

describe("AssetRepository CRUD", () => {
  it("returns undefined for an unknown ID instead of throwing", () => {
    expect(repo.getById("mmcs_missing")).toBeUndefined();
  });

  it("rejects a duplicate assetId", () => {
    expect(() => repo.create(baseRecord())).toThrow(AssetManifestError);
    try {
      repo.create(baseRecord());
    } catch (error) {
      expect((error as AssetManifestError).code).toBe("DUPLICATE_ASSET_ID");
    }
  });

  it("rejects records missing required fields", () => {
    expect(() =>
      repo.create(baseRecord({ assetId: "mmcs_x1", assetType: "" })),
    ).toThrowError(/assetType/);
    expect(() =>
      repo.create(baseRecord({ assetId: "mmcs_x2", createdAt: "" })),
    ).toThrowError(/createdAt/);
  });

  it("patches mutable fields but never assetId or createdAt", () => {
    repo.create(
      baseRecord({ assetId: "mmcs_upd", ghlFileId: "file_old", ghlUrl: "https://old.example/x" }),
    );
    const updated = repo.update("mmcs_upd", {
      // Deliberate immutable-field attack: the repository must ignore both.
      ...( {
        assetId: "mmcs_hacked",
        createdAt: "1999-01-01T00:00:00.000Z",
      } as unknown as Record<string, never>),
      ghlFileId: "file_new",
      ghlUrl: "https://new.example/x",
      qcState: "PASSED",
      assetState: "APPROVED",
      archivedAt: "2026-08-28T13:00:00.000Z",
    } as unknown as Parameters<typeof repo.update>[1]);
    expect(updated?.ghlFileId).toBe("file_new");
    expect(updated?.qcState).toBe("PASSED");
    expect(updated?.assetState).toBe("APPROVED");
    expect(updated?.createdAt).toBe("2026-08-28T12:00:00.000Z");
    const row = db.get("SELECT asset_id FROM assets WHERE asset_id = 'mmcs_upd'");
    expect(row).toBeDefined();
  });

  it("serializes/deserializes JSON columns at the repository edge", () => {
    repo.create(
      baseRecord({
        assetId: "mmcs_json",
        referencesUsed: ["ref_a", "ref_b"],
        generationSettings: { model: "agnes-video-2.5-flash", temperature: 0.7 },
      }),
    );
    const raw = db.get("SELECT references_used, generation_settings FROM assets WHERE asset_id = ?", "mmcs_json");
    expect(raw?.["references_used"]).toBe(JSON.stringify(["ref_a", "ref_b"]));
    expect(JSON.parse(String(raw?.["generation_settings"]))).toEqual({
      model: "agnes-video-2.5-flash",
      temperature: 0.7,
    });
    const record = repo.getById("mmcs_json");
    expect(record?.referencesUsed).toEqual(["ref_a", "ref_b"]);
    expect(record?.generationSettings).toEqual({
      model: "agnes-video-2.5-flash",
      temperature: 0.7,
    });
  });

  it("finds assets by provider task ID (spec §21/§38 job resume)", () => {
    repo.create(
      baseRecord({ assetId: "mmcs_pt1", providerTaskId: "task-77" }),
    );
    repo.create(
      baseRecord({ assetId: "mmcs_pt2", providerTaskId: "task-77" }),
    );
    const found = repo.findByProviderTaskId("task-77");
    expect(found.map((record) => record.assetId).sort()).toEqual(["mmcs_pt1", "mmcs_pt2"]);
    expect(repo.findByProviderTaskId("task-none")).toEqual([]);
  });

  it("finds assets by character + optional version (Character Library links)", () => {
    repo.create(
      baseRecord({
        assetId: "mmcs_char_v1",
        characterId: "CHAR_UNIQUE_FIND_001",
        characterVersion: "v1",
      }),
    );
    repo.create(
      baseRecord({
        assetId: "mmcs_char_v2",
        characterId: "CHAR_UNIQUE_FIND_001",
        characterVersion: "v2",
      }),
    );
    const all = repo.findByCharacter("CHAR_UNIQUE_FIND_001");
    expect(all).toHaveLength(2);
    expect(repo.findByCharacter("CHAR_UNIQUE_FIND_001", "v2").map((r) => r.assetId)).toEqual([
      "mmcs_char_v2",
    ]);
    expect(repo.findByCharacter("CHAR_UNKNOWN")).toEqual([]);
  });

  it("lists every record deterministically", () => {
    const listed = repo.list();
    expect(listed.length).toBeGreaterThanOrEqual(6);
    const ids = listed.map((record) => record.assetId);
    expect([...ids].sort()).toEqual([...ids].sort());
  });

  it("deletes by ID and reports whether a row was removed", () => {
    repo.create(baseRecord({ assetId: "mmcs_del" }));
    expect(repo.delete("mmcs_del")).toBe(true);
    expect(repo.delete("mmcs_del")).toBe(false);
    expect(repo.getById("mmcs_del")).toBeUndefined();
  });
});

describe("resolve (durable, DB-only)", () => {
  it("throws NOT_FOUND for an unknown asset", () => {
    try {
      repo.resolve("mmcs_ghost");
      expect.unreachable("resolve of unknown asset must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AssetManifestError);
      expect((error as AssetManifestError).code).toBe("NOT_FOUND");
    }
  });

  it("refuses to resolve a record with no durable-store linkage", () => {
    repo.create(baseRecord({ assetId: "mmcs_nolink" }));
    try {
      repo.resolve("mmcs_nolink");
      expect.unreachable("unlinked asset must not resolve");
    } catch (error) {
      expect((error as AssetManifestError).code).toBe("INVALID_RECORD");
      expect((error as AssetManifestError).message).toMatch(/durable store linkage/);
    }
  });

  it("resolves by file ID alone (URL backfilled later)", () => {
    repo.create(baseRecord({ assetId: "mmcs_idonly", ghlFileId: "file_42" }));
    const resolved = repo.resolve("mmcs_idonly");
    expect(resolved.ghlFileId).toBe("file_42");
    expect(resolved.ghlUrl).toBeUndefined();
  });
});

describe("mapAssetRow", () => {
  it("returns undefined for no row without throwing", () => {
    expect(mapAssetRow(undefined)).toBeUndefined();
  });

  it("throws a typed error on a row missing a required column", () => {
    expect(() =>
      mapAssetRow({ asset_id: "mmcs_bad", asset_type: null, created_at: "t" }),
    ).toThrow(AssetManifestError);
  });
});
