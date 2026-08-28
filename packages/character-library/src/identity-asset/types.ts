/**
 * Canonical identity asset metadata — spec §9 "Canonical identity asset record".
 *
 * Durable media linkage (not prose): every generated identity asset carries the
 * full canonical record — MMCS asset ID, character ID, identity version, GHL
 * media file/folder IDs, durable GHL URL, SHA-256, optional local cache path,
 * image dimensions, generation provider/model, source job ID, prompt, approval
 * state, and the canonical flag.
 */

/** Asset approval lifecycle, spec §9 "Asset states" (plus REJECTED). */
export const ASSET_APPROVAL_STATES = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
  "REJECTED",
] as const;

export type AssetApprovalState = (typeof ASSET_APPROVAL_STATES)[number];

/** Every field of the spec §9 canonical identity asset record. */
export const IDENTITY_ASSET_FIELDS = [
  "assetId",
  "characterId",
  "identityVersion",
  "ghlFileId",
  "ghlFolderId",
  "ghlUrl",
  "sha256",
  "localCachePath",
  "width",
  "height",
  "provider",
  "model",
  "sourceJobId",
  "prompt",
  "approvalState",
  "canonical",
] as const;

export type IdentityAssetField = (typeof IDENTITY_ASSET_FIELDS)[number];

/** Image dimensions of the identity asset, in pixels. */
export interface AssetDimensions {
  width: number;
  height: number;
}

/**
 * The canonical identity asset record (spec §9). Durable GHL linkage
 * (`ghlFileId`/`ghlUrl`/`sha256`) is nullable until archival completes; a
 * canonical asset always carries all three.
 */
export interface IdentityAsset {
  /** MMCS asset ID (stable business ID, `IDENT_ASSET_…` style). */
  assetId: string;
  /** Owning character's permanent business ID (`CHAR_…` style, never name-keyed). */
  characterId: string;
  /** Identity version this asset belongs to (e.g. `v1`); immutable history. */
  identityVersion: string;
  /** GHL media file ID for the archived asset; null until archived. */
  ghlFileId: string | null;
  /** GHL folder ID the asset was archived into; null until archived. */
  ghlFolderId: string | null;
  /** Durable GHL URL — used verbatim downstream; null until archived. */
  ghlUrl: string | null;
  /** SHA-256 checksum of the media bytes (lowercase hex); null until archived. */
  sha256: string | null;
  /** Local cache path if present; canonical linkage survives its removal. */
  localCachePath: string | null;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Generation provider (e.g. `kie`, `fal`, `gemini`). */
  provider: string;
  /** Generation model as called (e.g. `seedance-2.0-mini`). */
  model: string;
  /** Source generation task/job ID for provenance and duplicate prevention. */
  sourceJobId: string | null;
  /** The prompt that produced the asset. */
  prompt: string;
  /** Approval state: DRAFT → REVIEW → APPROVED → CANONICAL → RETIRED (+ REJECTED). */
  approvalState: AssetApprovalState;
  /** Canonical flag — true only once the character is LOCKED (state CANONICAL). */
  canonical: boolean;
}

/** Input accepted by {@linkcode createIdentityAsset}; optional fields defaulted. */
export interface IdentityAssetInput {
  assetId?: string;
  characterId: string;
  identityVersion: string;
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
  localCachePath?: string | null;
  width: number;
  height: number;
  provider: string;
  model: string;
  sourceJobId?: string | null;
  prompt: string;
  approvalState?: AssetApprovalState;
  canonical?: boolean;
}

/** Allowed approval-state edges, spec §9 asset-state lifecycle. */
export const ASSET_STATE_TRANSITIONS: Readonly<
  Record<AssetApprovalState, readonly AssetApprovalState[]>
> = {
  DRAFT: ["REVIEW", "REJECTED"],
  REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["CANONICAL"],
  CANONICAL: ["RETIRED"],
  RETIRED: [],
  REJECTED: [],
};