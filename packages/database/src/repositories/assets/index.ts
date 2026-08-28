import type { SqlValue } from "../../connection/index.js";
import { BaseRepository, type CrudRepository } from "../base.js";

/**
 * Durable asset-manifest record (spec §19): every media asset gets a DB
 * row carrying the full 26-field manifest; provenance lives here, not in
 * filenames. JSON columns (`referencesUsed`, `generationSettings`) are
 * TEXT in SQLite and serialize at this edge (PostgreSQL `jsonb` later).
 */
export interface AssetManifest {
  readonly assetId: string;
  readonly seriesId?: string;
  readonly episodeId?: string;
  readonly sceneId?: string;
  readonly shotId?: string;
  readonly characterId?: string;
  readonly characterVersion?: string;
  readonly assetType: string;
  readonly assetState: string;
  readonly provider?: string;
  readonly providerModel?: string;
  readonly providerTaskId?: string;
  readonly originalProviderUrl?: string;
  readonly providerUrlExpiration?: string;
  readonly ghlFileId?: string;
  readonly ghlFolderId?: string;
  readonly ghlUrl?: string;
  readonly checksum?: string;
  readonly localPath?: string;
  readonly prompt?: string;
  readonly promptCharacterCount?: number;
  readonly referencesUsed?: readonly string[];
  readonly generationSettings?: Record<string, unknown>;
  readonly cost?: number;
  readonly generationSeconds?: number;
  readonly createdAt: string;
  readonly archivedAt?: string;
  readonly approvalState: string;
  readonly qcState: string;
}

/** The 26 spec §19 manifest fields, in spec order — asserted by introspection. */
export const ASSET_MANIFEST_FIELDS = [
  "asset_id",
  "series_id",
  "episode_id",
  "scene_id",
  "shot_id",
  "character_id",
  "character_version",
  "asset_type",
  "asset_state",
  "provider",
  "provider_model",
  "provider_task_id",
  "original_provider_url",
  "provider_url_expiration",
  "ghl_file_id",
  "ghl_folder_id",
  "ghl_url",
  "checksum",
  "local_path",
  "prompt",
  "prompt_character_count",
  "references_used",
  "generation_settings",
  "cost",
  "generation_seconds",
  "created_at",
] as const;

export type AssetManifestField = (typeof ASSET_MANIFEST_FIELDS)[number];

/** Spec §18 job-safety columns every provider_jobs table must carry. */
export const JOB_SAFETY_FIELDS = [
  "request_hash",
  "idempotency_key",
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
] as const;

export type AssetPatch = {
  [K in Exclude<keyof AssetManifest, "assetId" | "createdAt">]?: AssetManifest[K];
};

const ASSET_COLUMNS = [
  "asset_id",
  "series_id",
  "episode_id",
  "scene_id",
  "shot_id",
  "character_id",
  "character_version",
  "asset_type",
  "asset_state",
  "provider",
  "provider_model",
  "provider_task_id",
  "original_provider_url",
  "provider_url_expiration",
  "ghl_file_id",
  "ghl_folder_id",
  "ghl_url",
  "checksum",
  "local_path",
  "prompt",
  "prompt_character_count",
  "references_used",
  "generation_settings",
  "cost",
  "generation_seconds",
  "created_at",
  "archived_at",
  "approval_state",
  "qc_state",
] as const;

export class AssetRepository extends BaseRepository implements CrudRepository<string, AssetManifest, AssetPatch> {
  readonly name = "assets";

  create(entity: AssetManifest): AssetManifest {
    this.db
      .prepare(
        `INSERT INTO assets (
           asset_id, series_id, episode_id, scene_id, shot_id, character_id, character_version,
           asset_type, asset_state, provider, provider_model, provider_task_id,
           original_provider_url, provider_url_expiration, ghl_file_id, ghl_folder_id, ghl_url,
           checksum, local_path, prompt, prompt_character_count, references_used,
           generation_settings, cost, generation_seconds, created_at, archived_at,
           approval_state, qc_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.assetId,
        entity.seriesId ?? null,
        entity.episodeId ?? null,
        entity.sceneId ?? null,
        entity.shotId ?? null,
        entity.characterId ?? null,
        entity.characterVersion ?? null,
        entity.assetType,
        entity.assetState,
        entity.provider ?? null,
        entity.providerModel ?? null,
        entity.providerTaskId ?? null,
        entity.originalProviderUrl ?? null,
        entity.providerUrlExpiration ?? null,
        entity.ghlFileId ?? null,
        entity.ghlFolderId ?? null,
        entity.ghlUrl ?? null,
        entity.checksum ?? null,
        entity.localPath ?? null,
        entity.prompt ?? null,
        entity.promptCharacterCount ?? null,
        entity.referencesUsed === undefined ? null : JSON.stringify(entity.referencesUsed),
        entity.generationSettings === undefined ? null : JSON.stringify(entity.generationSettings),
        entity.cost ?? null,
        entity.generationSeconds ?? null,
        entity.createdAt,
        entity.archivedAt ?? null,
        entity.approvalState,
        entity.qcState,
      );
    return this.findById(entity.assetId) as AssetManifest;
  }

  findById(id: string): AssetManifest | undefined {
    return this.mapRow<Record<string, SqlValue>, AssetManifest>(
      this.db.get(`SELECT ${ASSET_COLUMNS.join(", ")} FROM assets WHERE asset_id = ?`, id),
      mapAssetRow,
    );
  }

  update(id: string, patch: AssetPatch): AssetManifest | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    const next = { ...existing, ...patch } as AssetManifest;
    this.db
      .prepare(
        `UPDATE assets SET
           series_id = ?, episode_id = ?, scene_id = ?, shot_id = ?, character_id = ?,
           character_version = ?, asset_type = ?, asset_state = ?, provider = ?,
           provider_model = ?, provider_task_id = ?, original_provider_url = ?,
           provider_url_expiration = ?, ghl_file_id = ?, ghl_folder_id = ?, ghl_url = ?,
           checksum = ?, local_path = ?, prompt = ?, prompt_character_count = ?,
           references_used = ?, generation_settings = ?, cost = ?, generation_seconds = ?,
           archived_at = ?, approval_state = ?, qc_state = ?
         WHERE asset_id = ?`,
      )
      .run(
        next.seriesId ?? null,
        next.episodeId ?? null,
        next.sceneId ?? null,
        next.shotId ?? null,
        next.characterId ?? null,
        next.characterVersion ?? null,
        next.assetType,
        next.assetState,
        next.provider ?? null,
        next.providerModel ?? null,
        next.providerTaskId ?? null,
        next.originalProviderUrl ?? null,
        next.providerUrlExpiration ?? null,
        next.ghlFileId ?? null,
        next.ghlFolderId ?? null,
        next.ghlUrl ?? null,
        next.checksum ?? null,
        next.localPath ?? null,
        next.prompt ?? null,
        next.promptCharacterCount ?? null,
        next.referencesUsed === undefined ? null : JSON.stringify(next.referencesUsed),
        next.generationSettings === undefined ? null : JSON.stringify(next.generationSettings),
        next.cost ?? null,
        next.generationSeconds ?? null,
        next.archivedAt ?? null,
        next.approvalState,
        next.qcState,
        id,
      );
    return this.findById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM assets WHERE asset_id = ?").run(id).changes) > 0;
  }

  list(): AssetManifest[] {
    return this.db
      .all(`SELECT ${ASSET_COLUMNS.join(", ")} FROM assets ORDER BY created_at, asset_id`)
      .map(mapAssetRow);
  }

  /** All assets for one episode (manifest rendering). */
  listByEpisode(episodeId: string): AssetManifest[] {
    return this.db
      .all(`SELECT ${ASSET_COLUMNS.join(", ")} FROM assets WHERE episode_id = ? ORDER BY created_at, asset_id`, episodeId)
      .map(mapAssetRow);
  }

  /** All assets generated by one provider task (archive-after-generation). */
  listByProviderTask(providerTaskId: string): AssetManifest[] {
    return this.db
      .all(
        `SELECT ${ASSET_COLUMNS.join(", ")} FROM assets WHERE provider_task_id = ? ORDER BY created_at, asset_id`,
        providerTaskId,
      )
      .map(mapAssetRow);
  }
}

function mapAssetRow(row: Record<string, SqlValue>): AssetManifest {
  return {
    assetId: String(row["asset_id"]),
    seriesId: row["series_id"] === null ? undefined : String(row["series_id"]),
    episodeId: row["episode_id"] === null ? undefined : String(row["episode_id"]),
    sceneId: row["scene_id"] === null ? undefined : String(row["scene_id"]),
    shotId: row["shot_id"] === null ? undefined : String(row["shot_id"]),
    characterId: row["character_id"] === null ? undefined : String(row["character_id"]),
    characterVersion: row["character_version"] === null ? undefined : String(row["character_version"]),
    assetType: String(row["asset_type"]),
    assetState: String(row["asset_state"]),
    provider: row["provider"] === null ? undefined : String(row["provider"]),
    providerModel: row["provider_model"] === null ? undefined : String(row["provider_model"]),
    providerTaskId: row["provider_task_id"] === null ? undefined : String(row["provider_task_id"]),
    originalProviderUrl: row["original_provider_url"] === null ? undefined : String(row["original_provider_url"]),
    providerUrlExpiration: row["provider_url_expiration"] === null ? undefined : String(row["provider_url_expiration"]),
    ghlFileId: row["ghl_file_id"] === null ? undefined : String(row["ghl_file_id"]),
    ghlFolderId: row["ghl_folder_id"] === null ? undefined : String(row["ghl_folder_id"]),
    ghlUrl: row["ghl_url"] === null ? undefined : String(row["ghl_url"]),
    checksum: row["checksum"] === null ? undefined : String(row["checksum"]),
    localPath: row["local_path"] === null ? undefined : String(row["local_path"]),
    prompt: row["prompt"] === null ? undefined : String(row["prompt"]),
    promptCharacterCount: row["prompt_character_count"] === null ? undefined : Number(row["prompt_character_count"]),
    referencesUsed:
      row["references_used"] === null || row["references_used"] === undefined
        ? undefined
        : (JSON.parse(String(row["references_used"])) as string[]),
    generationSettings:
      row["generation_settings"] === null || row["generation_settings"] === undefined
        ? undefined
        : (JSON.parse(String(row["generation_settings"])) as Record<string, unknown>),
    cost: row["cost"] === null ? undefined : Number(row["cost"]),
    generationSeconds: row["generation_seconds"] === null ? undefined : Number(row["generation_seconds"]),
    createdAt: String(row["created_at"]),
    archivedAt: row["archived_at"] === null ? undefined : String(row["archived_at"]),
    approvalState: String(row["approval_state"]),
    qcState: String(row["qc_state"]),
  };
}