/// <reference types="node" />
/**
 * Asset manifest record types (spec §19) — the durable DB record every media
 * asset carries. Provenance lives here, never in filenames/folders alone.
 *
 * The 26 spec §19 fields are the contract; the record adds the three
 * lifecycle columns the `assets` schema (CORE-007, band `004_`) carries for
 * them: `archived_at`, `approval_state`, `qc_state`. Column names in the
 * database are snake_case; this TypeScript surface is camelCase and the
 * repository maps at the edge (PostgreSQL `jsonb` migration later).
 *
 * Field order below mirrors spec §19 exactly — `ASSET_MANIFEST_FIELDS`
 * (snake_case, spec order) is asserted by introspection in the tests.
 */

/**
 * The 26 spec §19 manifest fields, in spec order.
 */
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

/** Spec §18 asset lifecycle states (the `assets.asset_state` CHECK domain). */
export type AssetState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

/** Human approval state persisted beside the asset (PENDING until gated). */
export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED";

/** Automated QC state persisted beside the asset (PENDING until QC ran). */
export type QcState = "PENDING" | "PASSED" | "FAILED" | "FIXING";

/** The durable asset-manifest record (spec §19, all fields). */
export interface AssetRecord {
  readonly assetId: string;
  readonly seriesId?: string;
  readonly episodeId?: string;
  readonly sceneId?: string;
  readonly shotId?: string;
  readonly characterId?: string;
  readonly characterVersion?: string;
  readonly assetType: string;
  readonly assetState: AssetState;
  readonly provider?: string;
  readonly providerModel?: string;
  readonly providerTaskId?: string;
  /** Temporary provider URL, preserved verbatim for provenance/recovery. */
  readonly originalProviderUrl?: string;
  /** When the provider URL expires (ISO 8601), when the provider reports it. */
  readonly providerUrlExpiration?: string;
  /** Durable store file ID (e.g. GHL fileId). */
  readonly ghlFileId?: string;
  /** Durable store folder ID (e.g. GHL folderId). */
  readonly ghlFolderId?: string;
  /** Durable store URL — the canonical long-term location. */
  readonly ghlUrl?: string;
  /** SHA-256 hex checksum of the archived bytes, when known. */
  readonly checksum?: string;
  /** Local cache path if present — never the source of truth. */
  readonly localPath?: string;
  readonly prompt?: string;
  readonly promptCharacterCount?: number;
  /** Reference asset IDs used to generate this asset. */
  readonly referencesUsed?: readonly string[];
  readonly generationSettings?: Record<string, unknown>;
  readonly cost?: number;
  readonly generationSeconds?: number;
  readonly createdAt: string;
  /** Set when the asset was verified archived into the durable store. */
  readonly archivedAt?: string;
  readonly approvalState: ApprovalState;
  readonly qcState: QcState;
}

/** Mutable subset for `update` — identity and creation time are immutable. */
export type AssetRecordPatch = Partial<
  Omit<AssetRecord, "assetId" | "createdAt">
>;

/** Fields that must never be absent on create. */
export const REQUIRED_ASSET_RECORD_FIELDS = [
  "assetId",
  "assetType",
  "assetState",
  "approvalState",
  "qcState",
  "createdAt",
] as const;

export class AssetManifestError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "DUPLICATE_ASSET_ID"
    | "MISSING_FIELD"
    | "INVALID_RECORD";

  constructor(
    code: AssetManifestError["code"],
    message: string,
    context: { assetId?: string } = {},
  ) {
    super(
      `[${code}] ${message}` +
        (context.assetId !== undefined ? ` (asset ${context.assetId})` : ""),
    );
    this.name = "AssetManifestError";
    this.code = code;
  }
}
