/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "@mmcs/database";
import { AssetRepository } from "./asset-repository.js";
import { BaseMediaStore } from "./media-store.js";
import { GhlLocationMismatchError, MissingGhlLocationError } from "../ghl/tenant.js";
import {
  ArchivalLedger,
  archivalKey,
} from "../ghl/retry/index.js";
import {
  GHL_MEDIA_STORE_KIND,
  GhlMediaStoreConfigurationError,
  GoHighLevelMediaStore,
  type GoHighLevelMediaStoreOptions,
} from "./gohighlevel-media-store.js";
import type {
  ArchiveAssetRequest,
  MediaStoreUploadResult,
} from "./media-store.js";
import type { AssetRecord } from "./types.js";

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
let assets: AssetRepository;
let cacheDir: string;

beforeAll(() => {
  db = connectSqlite({ path: ":memory:" });
  db.exec(ASSETS_TABLE_DDL);
  assets = new AssetRepository(db);
  // A local "cache" directory proves resolution never touches the filesystem:
  // it is removed mid-test while the DB (the durable record) survives.
  cacheDir = mkdtempSync(join(tmpdir(), "mmcs-manifest-cache-"));
});

afterAll(() => {
  db.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

function record(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    assetId: "mmcs_asset_store_1",
    assetType: "video",
    assetState: "REVIEW",
    provider: "agnes",
    providerModel: "agnes-video-2.5-flash",
    providerTaskId: "job_store_1",
    originalProviderUrl: "https://tmp.provider.example/clip.mp4",
    providerUrlExpiration: "2026-08-29T00:00:00.000Z",
    localPath: join(cacheDir, "clip.mp4"),
    prompt: "Monica walks to the window",
    promptCharacterCount: 28,
    referencesUsed: ["mmcs_asset_ref_1"],
    generationSettings: { resolution: "720p" },
    cost: 0.35,
    generationSeconds: 6,
    approvalState: "PENDING",
    qcState: "PENDING",
    createdAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function verifiedUpload(overrides: Partial<MediaStoreUploadResult> = {}): MediaStoreUploadResult {
  return {
    fileId: "ghl_file_verified",
    url: "https://storage.gohighlevel.example/ghl_file_verified",
    folderId: "ghl_folder_episode",
    verifiedAt: "2026-08-28T12:01:00.000Z",
    ...overrides,
  };
}

function okIngest(result: Partial<MediaStoreUploadResult> = {}) {
  const calls: { name: string; parentId: string; fileUrl?: string; altId?: string }[] = [];
  const ingest = async (request: {
    name: string;
    parentId: string;
    fileUrl?: string;
    altId?: string;
  }): Promise<MediaStoreUploadResult> => {
    calls.push(request);
    return verifiedUpload(result);
  };
  return { ingest, calls };
}

describe("MediaStore abstraction", () => {
  it("exposes the seam contract: kind, archiveAsset, resolveAsset, getAsset, updateAsset", async () => {
    class TestStore extends BaseMediaStore {
      readonly kind = "test";
    }
    const store = new TestStore({ assets });
    expect(store.kind).toBe("test");
    expect(typeof store.archiveAsset).toBe("function");
    expect(typeof store.resolveAsset).toBe("function");
    expect(typeof store.getAsset).toBe("function");
    expect(typeof store.updateAsset).toBe("function");

    const { ingest } = okIngest();
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_abs_1" }),
      ingest,
      parentId: "ghl_folder_episode",
    });
    expect(archived.uploaded).toBe(true);
    expect(archived.record.ghlFileId).toBe("ghl_file_verified");
    expect(archived.record.ghlFolderId).toBe("ghl_folder_episode");
    expect(archived.record.ghlUrl).toContain("https://");
    expect(archived.record.archivedAt).toBe("2026-08-28T12:01:00.000Z");
  });

  it("writes the full spec §19 record including ghl linkage + archivedAt", async () => {
    const { ingest } = okIngest({ checksum: "c".repeat(64) });
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_abs_2" }),
      ingest,
      parentId: "ghl_folder_episode",
    });
    const persisted = assets.getById("mmcs_abs_2");
    expect(persisted).toEqual(archived.record);
    expect(persisted?.ghlFileId).toBe("ghl_file_verified");
    expect(persisted?.ghlFolderId).toBe("ghl_folder_episode");
    expect(persisted?.ghlUrl).toBe("https://storage.gohighlevel.example/ghl_file_verified");
    expect(persisted?.checksum).toBe("c".repeat(64));
    expect(persisted?.providerTaskId).toBe("job_store_1");
    expect(persisted?.originalProviderUrl).toBe("https://tmp.provider.example/clip.mp4");
    expect(persisted?.archivedAt).toBe("2026-08-28T12:01:00.000Z");
  });

  it("rejects an unverified ingest result (no fileId/url) — never ARCHIVED", async () => {
    const ingest = async (): Promise<MediaStoreUploadResult> => verifiedUpload({ fileId: "", url: "" });
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "mmcs_abs_3" }),
        ingest,
        parentId: "f",
      }),
    ).rejects.toThrow(/NOT archived/);
    expect(assets.getById("mmcs_abs_3")).toBeUndefined();
  });

  it("requires a destination folder", async () => {
    const { ingest } = okIngest();
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "mmcs_abs_4" }),
        ingest,
      }),
    ).rejects.toThrow(/parentId/);
  });

  it("falls back to the binary ingest when the hosted ingest fails, keeping the checksum", async () => {
    let hostedAttempts = 0;
    let binaryAttempts = 0;
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => {
        hostedAttempts += 1;
        throw new Error("hosted ingest failed: provider URL expired");
      },
      binaryIngest: async (input) => {
        binaryAttempts += 1;
        expect(input.providerUrl).toBe("https://tmp.provider.example/clip.mp4");
        expect(input.locationId).toBe("loc_123");
        return {
          fileId: "ghl_binary_fb",
          url: "https://storage.gohighlevel.example/binary_fb",
          sourceChecksum: "e".repeat(64),
          verifiedChecksum: "e".repeat(64),
        };
      },
      deps: { assets },
    });
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_ghl_fallback" }),
      ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
      parentId: "ghl_folder_episode",
    });
    expect(hostedAttempts).toBe(1);
    expect(binaryAttempts).toBe(1);
    expect(archived.uploaded).toBe(true);
    expect(archived.record.ghlFileId).toBe("ghl_binary_fb");
    expect(archived.record.checksum).toBe("e".repeat(64));
    expect(assets.getById("mmcs_ghl_fallback")?.ghlUrl).toBe("https://storage.gohighlevel.example/binary_fb");
  });

  it("throws a configuration error when the hosted ingest fails and no binary fallback is wired", async () => {
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => {
        throw new Error("hosted ingest failed");
      },
      deps: { assets },
    });
    await expect(
      store.archiveAsset({
        record: record({ assetId: "mmcs_ghl_hfail" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
      }),
    ).rejects.toThrow(GhlMediaStoreConfigurationError);
    expect(assets.getById("mmcs_ghl_hfail")).toBeUndefined();
  });

  it("is idempotent: re-archiving a linked record never re-uploads", async () => {
    const { ingest, calls } = okIngest();
    const store = storeFor();
    const first = await store.archiveAsset({
      record: record({ assetId: "mmcs_abs_5" }),
      ingest,
      parentId: "ghl_folder_episode",
    });
    expect(first.uploaded).toBe(true);
    expect(calls).toHaveLength(1);
    const second = await store.archiveAsset({
      record: record({ assetId: "mmcs_abs_5" }),
      ingest,
      parentId: "ghl_folder_episode",
    });
    expect(second.uploaded).toBe(false);
    expect(second.record.ghlFileId).toBe("ghl_file_verified");
    expect(calls).toHaveLength(1); // no second upload — no duplicate durable copy
  });

  it("patches a linkage-less existing row instead of duplicating it", async () => {
    assets.create(record({ assetId: "mmcs_abs_6" }));
    const { ingest, calls } = okIngest();
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_abs_6" }),
      ingest,
      parentId: "ghl_folder_episode",
    });
    expect(archived.uploaded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(assets.getById("mmcs_abs_6")?.ghlUrl).toContain("https://");
  });

  it("propagates ingest failures — archival failure is not swallowed", async () => {
    const ingest = async (): Promise<MediaStoreUploadResult> => {
      throw new Error("GHL upload failed with status 500");
    };
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "mmcs_abs_7" }),
        ingest,
        parentId: "f",
      }),
    ).rejects.toThrow(/status 500/);
    expect(assets.getById("mmcs_abs_7")).toBeUndefined();
  });

  it("updateAsset patches manifest fields after archival", async () => {
    const { ingest } = okIngest();
    const store = storeFor();
    await store.archiveAsset({
      record: record({ assetId: "mmcs_abs_8" }),
      ingest,
      parentId: "f",
    });
    const updated = store.updateAsset("mmcs_abs_8", {
      assetState: "CANONICAL",
      approvalState: "APPROVED",
      qcState: "PASSED",
    });
    expect(updated?.assetState).toBe("CANONICAL");
    expect(updated?.approvalState).toBe("APPROVED");
    expect(updated?.qcState).toBe("PASSED");
  });
});

function storeFor(): BaseMediaStore {
  class TestStore extends BaseMediaStore {
    readonly kind = "test";
  }
  return new TestStore({ assets });
}

describe("GoHighLevelMediaStore", () => {
  it("exposes a correctly-spelled options type (regression: Gohl typo)", () => {
    // Regression for the misspelled public type name: the correctly-spelled
    // `GoHighLevelMediaStoreOptions` must exist and be the constructor type.
    const options: GoHighLevelMediaStoreOptions = {
      locationId: "loc_123",
      deps: { assets },
    };
    const made = new GoHighLevelMediaStore(options);
    expect(made.kind).toBe("gohighlevel");
  });

  it("declares the gohighlevel store kind", () => {
    expect(GHL_MEDIA_STORE_KIND).toBe("gohighlevel");
    expect(store().kind).toBe("gohighlevel");
  });

  it("rejects construction without a locationId", () => {
    expect(
      () =>
        new GoHighLevelMediaStore({
          locationId: "",
          deps: { assets },
        }),
    ).toThrow(GhlMediaStoreConfigurationError);
  });

  it("archives via the hosted ingest and persists ghl linkage (spec §35.3)", async () => {
    const hostedCalls: { fileUrl: string; name: string; parentId: string; altId?: string }[] = [];
    const hosted = async (request: {
      fileUrl: string;
      name: string;
      parentId: string;
      altId?: string;
    }): Promise<MediaStoreUploadResult> => {
      hostedCalls.push(request);
      return verifiedUpload({ fileId: "ghl_hosted_1", url: "https://storage.gohighlevel.example/hosted_1" });
    };
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: hosted,
      deps: { assets },
    });
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_ghl_1" }),
      ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
      parentId: "ghl_folder_episode",
    });
    expect(archived.uploaded).toBe(true);
    expect(hostedCalls).toHaveLength(1);
    expect(hostedCalls[0]?.fileUrl).toBe("https://tmp.provider.example/clip.mp4");
    expect(hostedCalls[0]?.altId).toBe("loc_123");
    const persisted = store.getAsset("mmcs_ghl_1");
    expect(persisted?.ghlFileId).toBe("ghl_hosted_1");
    expect(persisted?.ghlFolderId).toBe("ghl_folder_episode");
    expect(persisted?.ghlUrl).toBe("https://storage.gohighlevel.example/hosted_1");
  });

  it("falls back to the binary ingest when hosted is not wired, carrying the checksum", async () => {
    const binaryCalls: { providerUrl: string; name: string; parentId: string; locationId: string }[] = [];
    const binary = async (input: {
      providerUrl: string;
      name: string;
      parentId: string;
      locationId: string;
    }): Promise<{ fileId: string; url: string; sourceChecksum: string; verifiedChecksum: string }> => {
      binaryCalls.push(input);
      return {
        fileId: "ghl_binary_1",
        url: "https://storage.gohighlevel.example/binary_1",
        sourceChecksum: "b".repeat(64),
        verifiedChecksum: "b".repeat(64),
      };
    };
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      binaryIngest: binary,
      deps: { assets },
    });
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_ghl_2" }),
      ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
      parentId: "ghl_folder_episode",
    });
    expect(binaryCalls).toHaveLength(1);
    expect(binaryCalls[0]?.providerUrl).toBe("https://tmp.provider.example/clip.mp4");
    expect(binaryCalls[0]?.locationId).toBe("loc_123");
    expect(archived.record.checksum).toBe("b".repeat(64));
  });

  it("throws a configuration error when no ingest can run", async () => {
    const store = new GoHighLevelMediaStore({ locationId: "loc_123", deps: { assets } });
    const ingest = store.ingestFor({});
    await expect(ingest({ name: "n", parentId: "f" })).rejects.toThrow(
      GhlMediaStoreConfigurationError,
    );
  });

  it("rejects an ingest that returns no verified fileId/url (never ARCHIVED)", async () => {
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => ({ fileId: "", url: "" }),
      deps: { assets },
    });
    await expect(
      store.archiveAsset({
        record: record({ assetId: "mmcs_ghl_unverified" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
      }),
    ).rejects.toThrow(/NOT archived/);
    expect(assets.getById("mmcs_ghl_unverified")).toBeUndefined();
  });

  it("rejects a binary ingest whose source and verified checksums differ", async () => {
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      binaryIngest: async () => ({
        fileId: "ghl_binary_bad",
        url: "https://storage.gohighlevel.example/binary_bad",
        sourceChecksum: "a".repeat(64),
        verifiedChecksum: "b".repeat(64),
      }),
      deps: { assets },
    });
    await expect(
      store.archiveAsset({
        record: record({ assetId: "mmcs_ghl_badsum" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
      }),
    ).rejects.toThrow(/integrity mismatch/);
    expect(assets.getById("mmcs_ghl_badsum")).toBeUndefined();
  });
});

function store(): GoHighLevelMediaStore {
  return new GoHighLevelMediaStore({
    locationId: "loc_123",
    hostedIngest: async () => verifiedUpload(),
    deps: { assets },
  });
}

describe("resolve-after-local-cache-removal (spec acceptance, via DB)", () => {
  it("resolves the durable asset after the local cache file AND directory are removed", async () => {
    const cacheFile = join(cacheDir, "monica_shot.mp4");
    const { ingest } = okIngest({
      fileId: "ghl_file_monica",
      url: "https://storage.gohighlevel.example/ghl_file_monica/monica_shot.mp4",
      checksum: "d".repeat(64),
    });
    const store = storeFor();
    await store.archiveAsset({
      record: record({
        assetId: "mmcs_asset_monica",
        localPath: cacheFile,
        ghlFileId: undefined,
        ghlUrl: undefined,
      }),
      ingest,
      parentId: "ghl_folder_episode",
    });

    // Simulate local cache eviction: remove the file and the cache directory.
    rmSync(cacheFile, { force: true });
    rmSync(cacheDir, { recursive: true, force: true });

    // Resolution reads ONLY the durable DB manifest record.
    const resolved = store.resolveAsset("mmcs_asset_monica");
    expect(resolved.ghlFileId).toBe("ghl_file_monica");
    expect(resolved.ghlUrl).toBe("https://storage.gohighlevel.example/ghl_file_monica/monica_shot.mp4");
    expect(resolved.record.checksum).toBe("d".repeat(64));
    expect(resolved.record.providerTaskId).toBe("job_store_1");
    expect(resolved.record.archivedAt).toBe("2026-08-28T12:01:00.000Z");
  });

  it("resolution is reproducible from a fresh DB connection (restart survival)", async () => {
    // A second connection to the same file-backed DB — the manifest survives
    // process restart because it lives in SQLite, not in memory.
    const dir = mkdtempSync(join(tmpdir(), "mmcs-manifest-restart-"));
    const dbPath = join(dir, "manifest.db");
    try {
      const writer = connectSqlite({ path: dbPath });
      writer.exec(ASSETS_TABLE_DDL);
      const writerRepo = new AssetRepository(writer);
      class TestStore extends BaseMediaStore {
        readonly kind = "test";
      }
      const writerStore = new TestStore({ assets: writerRepo });
      const { ingest } = okIngest({ fileId: "file_r", url: "https://r.example/f" });
      await writerStore.archiveAsset({
        record: record({ assetId: "mmcs_restart_1", localPath: join(dir, "gone.mp4") }),
        ingest,
        parentId: "f",
      });
      writer.close();

      const reader = connectSqlite({ path: dbPath });
      const readerRepo = new AssetRepository(reader);
      const readerStore = new TestStore({ assets: readerRepo });
      const resolved = readerStore.resolveAsset("mmcs_restart_1");
      expect(resolved.ghlFileId).toBe("file_r");
      expect(resolved.ghlUrl).toBe("https://r.example/f");
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ArchiveAssetRequest validation", () => {
  it("rejects a record without an assetId", async () => {
    const { ingest } = okIngest();
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "" }),
        ingest,
        parentId: "f",
      }),
    ).rejects.toThrow(/assetId/);
  });
});

describe("GHL tenant isolation (SKR-011)", () => {
  it("records the location the durable linkage was written under", async () => {
    const { ingest } = okIngest();
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_loc_1" }),
      ingest,
      parentId: "ghl_folder_episode",
      altId: "loc_A",
    });
    expect(archived.record.ghlLocationId).toBe("loc_A");
    // Persisted, not just returned: the stored GHL ids now name their owner.
    expect(assets.getById("mmcs_loc_1")?.ghlLocationId).toBe("loc_A");
  });

  it("refuses to re-archive a record persisted for another location", async () => {
    assets.create(record({ assetId: "mmcs_loc_2", ghlLocationId: "loc_A" }));
    const { ingest, calls } = okIngest();
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "mmcs_loc_2" }),
        ingest,
        parentId: "ghl_folder_episode",
        altId: "loc_B",
      }),
    ).rejects.toBeInstanceOf(GhlLocationMismatchError);
    expect(calls).toHaveLength(0); // nothing was uploaded to the wrong tenant
  });

  it("accepts the same location as the persisted record", async () => {
    assets.create(record({ assetId: "mmcs_loc_3", ghlLocationId: "loc_A" }));
    const { ingest } = okIngest();
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_loc_3" }),
      ingest,
      parentId: "ghl_folder_episode",
      altId: "loc_A",
    });
    expect(archived.uploaded).toBe(true);
    expect(archived.record.ghlLocationId).toBe("loc_A");
  });

  it("rejects a supplied-but-blank location instead of treating it as absent", async () => {
    const { ingest, calls } = okIngest();
    await expect(
      storeFor().archiveAsset({
        record: record({ assetId: "mmcs_loc_4" }),
        ingest,
        parentId: "ghl_folder_episode",
        altId: "   ",
      }),
    ).rejects.toBeInstanceOf(MissingGhlLocationError);
    expect(calls).toHaveLength(0);
  });
});

describe("pre-POST duplicate suppression by checksum (SKR-013)", () => {
  it("adopts an already-archived copy with the same checksum instead of uploading", async () => {
    const checksum = "f".repeat(64);
    const first = okIngest({ checksum });
    await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_dedupe_a", checksum }),
      ingest: first.ingest,
      parentId: "ghl_folder_episode",
    });
    expect(first.calls).toHaveLength(1);

    const second = okIngest({ checksum });
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_dedupe_b", checksum }),
      ingest: second.ingest,
      parentId: "ghl_folder_episode",
    });

    expect(second.calls).toHaveLength(0); // no second POST of identical bytes
    expect(archived.uploaded).toBe(false);
    expect(archived.record.ghlFileId).toBe("ghl_file_verified");
    expect(archived.record.ghlUrl).toContain("https://");
    expect(archived.record.checksum).toBe(checksum);
  });

  it("still uploads when the checksum matches but the destination folder differs", async () => {
    const checksum = "a".repeat(64);
    const first = okIngest({ checksum });
    await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_dedupe_c", checksum }),
      ingest: first.ingest,
      parentId: "folder_one",
    });
    const second = okIngest({ checksum });
    const archived = await storeFor().archiveAsset({
      record: record({ assetId: "mmcs_dedupe_d", checksum }),
      ingest: second.ingest,
      parentId: "folder_two",
    });
    expect(second.calls).toHaveLength(1);
    expect(archived.uploaded).toBe(true);
  });
});

describe("GoHighLevelMediaStore tenant + ledger wiring (SKR-011/SKR-013)", () => {
  it("refuses a caller-supplied location that is not the store's sub-account", async () => {
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => verifiedUpload(),
      deps: { assets },
    });
    await expect(
      store.archiveAsset({
        record: record({ assetId: "mmcs_tenant_x" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
        altId: "loc_OTHER",
      }),
    ).rejects.toBeInstanceOf(GhlLocationMismatchError);
    expect(assets.getById("mmcs_tenant_x")).toBeUndefined();
  });

  it("records the bound location on every archived asset", async () => {
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => verifiedUpload(),
      deps: { assets },
    });
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_tenant_ok" }),
      ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
      parentId: "ghl_folder_episode",
    });
    expect(archived.record.ghlLocationId).toBe("loc_123");
    expect(store.getAsset("mmcs_tenant_ok")?.ghlLocationId).toBe("loc_123");
  });

  it("reuses the ledger's recorded result when the manifest row never landed", async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "mmcs-ledger-"));
    try {
      const ledger = new ArchivalLedger(ledgerDir);
      // A manifest repository that reports no row for this asset — the
      // lost-success window: GHL accepted the file but the manifest write did
      // not survive. Only the ledger can stop the second POST.
      const forgetful = {
        getById: () => undefined,
        create: (entity: AssetRecord) => entity,
        update: () => undefined,
        findArchivedByChecksum: () => undefined,
      } as unknown as AssetRepository;
      let uploads = 0;
      const store = new GoHighLevelMediaStore({
        locationId: "loc_123",
        hostedIngest: async () => {
          uploads += 1;
          return verifiedUpload();
        },
        ledger,
        deps: { assets: forgetful },
      });
      const request = () => ({
        record: record({ assetId: "mmcs_ledger_1" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
      });
      const first = await store.archiveAsset(request());
      expect(first.uploaded).toBe(true);
      const second = await store.archiveAsset(request());
      expect(uploads).toBe(1); // the ledger returned the recorded GHL file
      expect(second.uploaded).toBe(false);
      expect(second.record.ghlFileId).toBe("ghl_file_verified");
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it("adopts an existing GHL file by canonical name before POSTing", async () => {
    const found: string[] = [];
    let uploads = 0;
    const store = new GoHighLevelMediaStore({
      locationId: "loc_123",
      hostedIngest: async () => {
        uploads += 1;
        return verifiedUpload();
      },
      findExistingFile: async (query) => {
        found.push(query.name);
        return { fileId: "ghl_existing", url: "https://storage.gohighlevel.example/existing" };
      },
      deps: { assets },
    });
    const archived = await store.archiveAsset({
      record: record({ assetId: "mmcs_by_name" }),
      ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
      parentId: "ghl_folder_episode",
    });
    expect(found).toEqual(["mmcs_by_name"]);
    expect(uploads).toBe(0); // dedupe by name happened before the POST
    expect(archived.record.ghlFileId).toBe("ghl_existing");
  });

  it("resolves a held reservation through the name lookup instead of re-uploading", async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "mmcs-ledger-held-"));
    try {
      const ledger = new ArchivalLedger(ledgerDir);
      const scope = "ghl-archival";
      // An earlier attempt crashed with the upload in flight: the reservation
      // exists and its outcome is unknown.
      await ledger.reserve(
        archivalKey(scope, {
          altId: "loc_123",
          parentId: "ghl_folder_episode",
          name: "mmcs_held_1",
          fileUrl: "https://tmp.provider.example/clip.mp4",
          providerTaskId: "job_store_1",
        }),
        scope,
        "hash",
      );
      let uploads = 0;
      const store = new GoHighLevelMediaStore({
        locationId: "loc_123",
        hostedIngest: async () => {
          uploads += 1;
          return verifiedUpload();
        },
        ledger,
        findExistingFile: async () => ({
          fileId: "ghl_from_reservation",
          url: "https://storage.gohighlevel.example/reserved",
        }),
        deps: { assets },
      });
      const archived = await store.archiveAsset({
        record: record({ assetId: "mmcs_held_1" }),
        ingest: store.ingestFor({ originalProviderUrl: "https://tmp.provider.example/clip.mp4" }),
        parentId: "ghl_folder_episode",
      });
      expect(uploads).toBe(0);
      expect(archived.record.ghlFileId).toBe("ghl_from_reservation");
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});
