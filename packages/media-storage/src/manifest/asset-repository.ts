/**
 * Asset-manifest repository — the durable `assets` record CRUD (spec §19).
 *
 * Sits on the `SqliteDatabase` seam (spec §25: repositories designed so a
 * PostgreSQL migration later is practical). The `assets` table itself is
 * owned by the schema band (CORE-007, `004-jobs-assets`); this module only
 * speaks to its documented column set. Tests create the identical table with
 * the same DDL so this package stays green both before and after the schema
 * band merges.
 *
 * JSON columns (`referencesUsed`, `generationSettings`) are TEXT in SQLite
 * and serialize at this edge; `null` means "absent", never "empty".
 */
import type { SqliteDatabase, SqlOutputValue } from "@mmcs/database";
import {
  ASSET_MANIFEST_FIELDS,
  type ApprovalState,
  type AssetRecord,
  type AssetRecordPatch,
  type AssetState,
  type QcState,
  AssetManifestError,
} from "./types.js";

/** All persisted columns, in the order the INSERT lists them. */
const COLUMNS = [
  ...ASSET_MANIFEST_FIELDS,
  "archived_at",
  "approval_state",
  "qc_state",
] as const;

type ColumnName = (typeof COLUMNS)[number];

function asString(value: SqlOutputValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: SqlOutputValue | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function parseJsonArray(value: SqlOutputValue | undefined): readonly string[] | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  throw new AssetManifestError("INVALID_RECORD", `references_used is not a JSON string array`);
}

function parseJsonObject(value: SqlOutputValue | undefined): Record<string, unknown> | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new AssetManifestError("INVALID_RECORD", `generation_settings is not a JSON object`);
}

function requireString(row: Record<string, SqlOutputValue>, column: ColumnName, assetId: string): string {
  const value = asString(row[column]);
  if (value === undefined) {
    throw new AssetManifestError("INVALID_RECORD", `assets.${column} missing or empty`, { assetId });
  }
  return value;
}

/** Map one raw `assets` row into the domain record (mapping at the edge). */
export function mapAssetRow(row: Record<string, SqlOutputValue> | undefined): AssetRecord | undefined {
  if (row === undefined) return undefined;
  const assetId = asString(row["asset_id"]);
  if (assetId === undefined) {
    throw new AssetManifestError("INVALID_RECORD", "assets.asset_id missing");
  }
  const record: AssetRecord = {
    assetId,
    seriesId: asString(row["series_id"]),
    episodeId: asString(row["episode_id"]),
    sceneId: asString(row["scene_id"]),
    shotId: asString(row["shot_id"]),
    characterId: asString(row["character_id"]),
    characterVersion: asString(row["character_version"]),
    assetType: requireString(row, "asset_type", assetId),
    assetState: requireString(row, "asset_state", assetId) as AssetState,
    provider: asString(row["provider"]),
    providerModel: asString(row["provider_model"]),
    providerTaskId: asString(row["provider_task_id"]),
    originalProviderUrl: asString(row["original_provider_url"]),
    providerUrlExpiration: asString(row["provider_url_expiration"]),
    ghlFileId: asString(row["ghl_file_id"]),
    ghlFolderId: asString(row["ghl_folder_id"]),
    ghlUrl: asString(row["ghl_url"]),
    checksum: asString(row["checksum"]),
    localPath: asString(row["local_path"]),
    prompt: asString(row["prompt"]),
    promptCharacterCount: asNumber(row["prompt_character_count"]),
    referencesUsed: parseJsonArray(row["references_used"]),
    generationSettings: parseJsonObject(row["generation_settings"]),
    cost: asNumber(row["cost"]),
    generationSeconds: asNumber(row["generation_seconds"]),
    createdAt: requireString(row, "created_at", assetId),
    archivedAt: asString(row["archived_at"]),
    approvalState: requireString(row, "approval_state", assetId) as ApprovalState,
    qcState: requireString(row, "qc_state", assetId) as QcState,
  };
  return record;
}

/** Durable asset-manifest persistence (spec §19 + §25). */
export class AssetRepository {
  readonly name = "assets";
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** Insert one manifest record. `assetId` must not already exist. */
  create(entity: AssetRecord): AssetRecord {
    this.validateRequired(entity);
    const existing = this.db.get("SELECT asset_id FROM assets WHERE asset_id = ?", entity.assetId);
    if (existing !== undefined) {
      throw new AssetManifestError("DUPLICATE_ASSET_ID", "asset already exists", {
        assetId: entity.assetId,
      });
    }
    this.db
      .prepare(
        `INSERT INTO assets (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
      )
      .run(...this.toRow(entity));
    return this.getById(entity.assetId) as AssetRecord;
  }

  /** Read one record by ID; `undefined` when absent. */
  getById(assetId: string): AssetRecord | undefined {
    return mapAssetRow(this.db.get("SELECT * FROM assets WHERE asset_id = ?", assetId));
  }

  /**
   * Resolve a durable asset by ID (spec acceptance: resolve-after-local-cache-
   * removal). Reads ONLY the database — no local filesystem dependency — so the
   * record survives local cache cleanup. A record without durable-store
   * linkage (`ghlFileId`/`ghlUrl`) throws; "resolvable" means the durable copy
   * is locatable, not that a cache file exists.
   */
  resolve(assetId: string): ResolvedAsset {
    const record = this.getById(assetId);
    if (record === undefined) {
      throw new AssetManifestError("NOT_FOUND", "asset not found in manifest DB", { assetId });
    }
    if (record.ghlFileId === undefined && record.ghlUrl === undefined) {
      throw new AssetManifestError(
        "INVALID_RECORD",
        "asset has no durable store linkage (ghl_file_id and ghl_url both empty) — not resolvable",
        { assetId },
      );
    }
    return { record, ghlFileId: record.ghlFileId, ghlUrl: record.ghlUrl };
  }

  /** Find all assets for one provider task/job ID (spec §21/§38 resume). */
  findByProviderTaskId(providerTaskId: string): AssetRecord[] {
    return this.db
      .all("SELECT * FROM assets WHERE provider_task_id = ?", providerTaskId)
      .map((row) => mapAssetRow(row) as AssetRecord);
  }

  /** Find assets by character + optional version (Character Library links). */
  findByCharacter(characterId: string, characterVersion?: string): AssetRecord[] {
    const rows =
      characterVersion === undefined
        ? this.db.all(
            "SELECT * FROM assets WHERE character_id = ? ORDER BY created_at, asset_id",
            characterId,
          )
        : this.db.all(
            "SELECT * FROM assets WHERE character_id = ? AND character_version = ? ORDER BY created_at, asset_id",
            characterId,
            characterVersion,
          );
    return rows.map((row) => mapAssetRow(row) as AssetRecord);
  }

  /** Patch any mutable field; identity (`assetId`) and `createdAt` immutable. */
  update(assetId: string, patch: AssetRecordPatch): AssetRecord | undefined {
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    for (const column of COLUMNS) {
      if (column === "asset_id" || column === "created_at") continue;
      const value = patchFieldValue(patch, column);
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    if (assignments.length === 0) return this.getById(assetId);
    this.db
      .prepare(`UPDATE assets SET ${assignments.join(", ")} WHERE asset_id = ?`)
      .run(...values, assetId);
    return this.getById(assetId);
  }

  /** Delete one record; true when a row was removed. */
  delete(assetId: string): boolean {
    const result = this.db.prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
    return Number(result.changes) > 0;
  }

  /** List every manifest record (deterministic order). */
  list(): AssetRecord[] {
    return this.db
      .all("SELECT * FROM assets ORDER BY created_at, asset_id")
      .map((row) => mapAssetRow(row) as AssetRecord);
  }

  private validateRequired(entity: AssetRecord): void {
    const missing: string[] = [];
    if (typeof entity.assetId !== "string" || entity.assetId.length === 0) {
      missing.push("assetId");
    }
    if (typeof entity.assetType !== "string" || entity.assetType.length === 0) {
      missing.push("assetType");
    }
    if (typeof entity.assetState !== "string" || entity.assetState.length === 0) {
      missing.push("assetState");
    }
    if (typeof entity.createdAt !== "string" || entity.createdAt.length === 0) {
      missing.push("createdAt");
    }
    if (missing.length > 0) {
      throw new AssetManifestError("MISSING_FIELD", `required fields missing: ${missing.join(", ")}`, {
        assetId: entity.assetId ?? "",
      });
    }
  }

  /** Serialize the record into the column order (JSON columns at this edge). */
  private toRow(entity: AssetRecord): (string | number | null)[] {
    return COLUMNS.map((column) => fieldToSql(entity, column));
  }
}

/** Resolved durable asset: the manifest record plus its durable-store locator. */
export interface ResolvedAsset {
  readonly record: AssetRecord;
  readonly ghlFileId?: string;
  readonly ghlUrl?: string;
}

function fieldToSql(entity: AssetRecord, column: ColumnName): string | number | null {
  switch (column) {
    case "asset_id":
      return entity.assetId;
    case "series_id":
      return entity.seriesId ?? null;
    case "episode_id":
      return entity.episodeId ?? null;
    case "scene_id":
      return entity.sceneId ?? null;
    case "shot_id":
      return entity.shotId ?? null;
    case "character_id":
      return entity.characterId ?? null;
    case "character_version":
      return entity.characterVersion ?? null;
    case "asset_type":
      return entity.assetType;
    case "asset_state":
      return entity.assetState;
    case "provider":
      return entity.provider ?? null;
    case "provider_model":
      return entity.providerModel ?? null;
    case "provider_task_id":
      return entity.providerTaskId ?? null;
    case "original_provider_url":
      return entity.originalProviderUrl ?? null;
    case "provider_url_expiration":
      return entity.providerUrlExpiration ?? null;
    case "ghl_file_id":
      return entity.ghlFileId ?? null;
    case "ghl_folder_id":
      return entity.ghlFolderId ?? null;
    case "ghl_url":
      return entity.ghlUrl ?? null;
    case "checksum":
      return entity.checksum ?? null;
    case "local_path":
      return entity.localPath ?? null;
    case "prompt":
      return entity.prompt ?? null;
    case "prompt_character_count":
      return entity.promptCharacterCount ?? null;
    case "references_used":
      return entity.referencesUsed === undefined ? null : JSON.stringify(entity.referencesUsed);
    case "generation_settings":
      return entity.generationSettings === undefined
        ? null
        : JSON.stringify(entity.generationSettings);
    case "cost":
      return entity.cost ?? null;
    case "generation_seconds":
      return entity.generationSeconds ?? null;
    case "created_at":
      return entity.createdAt;
    case "archived_at":
      return entity.archivedAt ?? null;
    case "approval_state":
      return entity.approvalState;
    case "qc_state":
      return entity.qcState;
  }
}

function patchFieldValue(patch: AssetRecordPatch, column: ColumnName): string | number | null | undefined {
  switch (column) {
    case "asset_id":
    case "created_at":
      return undefined; // identity + creation time immutable
    case "series_id":
      return patch.seriesId;
    case "episode_id":
      return patch.episodeId;
    case "scene_id":
      return patch.sceneId;
    case "shot_id":
      return patch.shotId;
    case "character_id":
      return patch.characterId;
    case "character_version":
      return patch.characterVersion;
    case "asset_type":
      return patch.assetType;
    case "asset_state":
      return patch.assetState;
    case "provider":
      return patch.provider;
    case "provider_model":
      return patch.providerModel;
    case "provider_task_id":
      return patch.providerTaskId;
    case "original_provider_url":
      return patch.originalProviderUrl;
    case "provider_url_expiration":
      return patch.providerUrlExpiration;
    case "ghl_file_id":
      return patch.ghlFileId;
    case "ghl_folder_id":
      return patch.ghlFolderId;
    case "ghl_url":
      return patch.ghlUrl;
    case "checksum":
      return patch.checksum;
    case "local_path":
      return patch.localPath;
    case "prompt":
      return patch.prompt;
    case "prompt_character_count":
      return patch.promptCharacterCount;
    case "references_used":
      return patch.referencesUsed === undefined ? undefined : JSON.stringify(patch.referencesUsed);
    case "generation_settings":
      return patch.generationSettings === undefined
        ? undefined
        : JSON.stringify(patch.generationSettings);
    case "cost":
      return patch.cost;
    case "generation_seconds":
      return patch.generationSeconds;
    case "archived_at":
      return patch.archivedAt;
    case "approval_state":
      return patch.approvalState;
    case "qc_state":
      return patch.qcState;
  }
}
