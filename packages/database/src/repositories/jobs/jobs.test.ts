/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { migrate } from "../../migrations/index.js";
import { jobsAssetsMigrations } from "../../migrations/004-jobs-assets/index.js";
import { AssetRepository, ASSET_MANIFEST_FIELDS } from "../assets/index.js";
import {
  JOB_STATES,
  JobStateTransitionError,
  ProviderJobRepository,
  isLegalJobTransition,
  type ProviderJobState,
} from "../index.js";

let dir: string;
let db: SqliteDatabase;
let jobs: ProviderJobRepository;
let assets: AssetRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-jobs-assets-"));
  db = connectSqlite({ path: join(dir, "jobs-assets.db") });
  migrate(db, jobsAssetsMigrations);
  jobs = new ProviderJobRepository(db);
  assets = new AssetRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function columnNames(table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).map((row) => String(row["name"]));
}

const BASE_JOB = {
  id: "job-0001",
  requestHash: "sha256:abc123",
  provider: "kie",
  providerModel: "seedance-2-mini",
  requestParams: { mode: "t2v", duration: 8 },
  createdAt: "2026-08-28T00:00:00.000Z",
} as const;

describe("provider_jobs schema — spec §18 job-safety fields", () => {
  it("carries every §18 job-safety column (asserted by introspection)", () => {
    const columns = columnNames("provider_jobs");
    const required = [
      "id",
      "idempotency_key",
      "request_hash",
      "provider",
      "provider_model",
      "provider_task_id",
      "request_params",
      "submitted_at",
      "status",
      "polled_at",
      "result_url",
      "archival_status",
      "retry_count",
    ];
    for (const field of required) {
      expect(columns).toContain(field);
    }
  });

  it("carries the §18 state-machine status enum covering PLANNED..REJECTED", () => {
    const checkRow = db.get(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_jobs'",
    );
    const ddl = String(checkRow?.["sql"] ?? "");
    for (const state of JOB_STATES) {
      expect(ddl).toContain(`'${state}'`);
    }
    // Full ladder from the spec, first to last:
    expect(JOB_STATES[0]).toBe("PLANNED");
    expect(JOB_STATES.at(-1)).toBe("REJECTED");
  });

  it("defaults a new job to PLANNED with archival status PENDING and retry 0", () => {
    const job = jobs.create({ ...BASE_JOB });
    expect(job.status).toBe("PLANNED");
    expect(job.archivalStatus).toBe("PENDING");
    expect(job.retryCount).toBe(0);
    expect(job.idempotencyKey).toBeUndefined();
  });
});

describe("assets schema — spec §19 manifest, all 26 fields by introspection", () => {
  it("carries every one of the 26 §19 manifest fields (introspection, exact spec names)", () => {
    const columns = columnNames("assets");
    for (const field of ASSET_MANIFEST_FIELDS) {
      expect(columns, `missing §19 field: ${field}`).toContain(field);
    }
    expect(ASSET_MANIFEST_FIELDS).toHaveLength(26);
  });

  it("round-trips a fully populated manifest row (JSON columns included)", () => {
    const manifest = {
      assetId: "asset-shot-0001",
      seriesId: "series-blue",
      episodeId: "ep-s01e03",
      sceneId: "sc-04",
      shotId: "sh-07",
      characterId: "monica",
      characterVersion: "v02",
      assetType: "shot_video",
      assetState: "DRAFT",
      provider: "agnes",
      providerModel: "video-2.5-flash",
      providerTaskId: "task-xyz",
      originalProviderUrl: "https://cdn.example/tmp/clip.mp4",
      providerUrlExpiration: "2026-08-29T00:00:00.000Z",
      ghlFileId: "file-1",
      ghlFolderId: "folder-1",
      ghlUrl: "https://mediaservices.example/file-1",
      checksum: "sha256:deadbeef",
      localPath: "media/projects/s01e03/S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
      prompt: "monica closeup, rain, neon",
      promptCharacterCount: 30,
      referencesUsed: ["ref-character-monica-v02", "ref-sc04-master"],
      generationSettings: { mode: "i2v", fps: 24, durationSeconds: 8 },
      cost: 0.42,
      generationSeconds: 61.5,
      createdAt: "2026-08-28T00:00:00.000Z",
      approvalState: "PENDING",
      qcState: "PENDING",
    };
    const created = assets.create(manifest);
    expect(created.assetId).toBe("asset-shot-0001");
    expect(created.referencesUsed).toEqual(["ref-character-monica-v02", "ref-sc04-master"]);
    expect(created.referencesUsed).toEqual(manifest.referencesUsed);
    expect(created.generationSettings).toEqual(manifest.generationSettings);
    expect(created.promptCharacterCount).toBe(30);
    expect(created.cost).toBeCloseTo(0.42);
    expect(created.generationSeconds).toBeCloseTo(61.5);
  });

  it("rejects unknown asset_state values (CHECK constraint)", () => {
    expect(() =>
      assets.create({
        assetId: "asset-bad-state",
        assetType: "shot_video",
        assetState: "NOT_A_STATE",
        createdAt: "2026-08-28T00:00:00.000Z",
        approvalState: "PENDING",
        qcState: "PENDING",
      }),
    ).toThrow();
  });

  it("supports the asset lifecycle updates (archive + QC + approval)", () => {
    const asset = assets.create({
      assetId: "asset-lifecycle",
      assetType: "shot_video",
      assetState: "DRAFT",
      createdAt: "2026-08-28T00:00:00.000Z",
      approvalState: "PENDING",
      qcState: "PENDING",
      originalProviderUrl: "https://cdn.example/tmp/life.mp4",
    });
    const archived = assets.update("asset-lifecycle", {
      archivedAt: "2026-08-28T01:00:00.000Z",
      ghlFileId: "file-77",
      qcState: "PASSED",
      approvalState: "APPROVED",
      assetState: "CANONICAL",
    });
    expect(archived?.archivedAt).toBe("2026-08-28T01:00:00.000Z");
    expect(archived?.ghlFileId).toBe("file-77");
    expect(archived?.qcState).toBe("PASSED");
    expect(archived?.approvalState).toBe("APPROVED");
    expect(asset).toBeDefined();
  });

  it("lists assets by episode and by provider task", () => {
    expect(assets.listByEpisode("ep-s01e03").map((a) => a.assetId)).toContain("asset-shot-0001");
    expect(assets.listByProviderTask("task-xyz").map((a) => a.assetId)).toEqual(["asset-shot-0001"]);
  });
});