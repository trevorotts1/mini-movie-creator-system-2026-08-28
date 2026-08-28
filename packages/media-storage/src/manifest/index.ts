/**
 * @mmcs/media-storage/manifest — asset manifest integration (MMCS GHL-008).
 *
 * Exports the MediaStore abstraction (spec §17/§35), the GHL implementation,
 * and the spec §19 durable asset-manifest record + repository.
 */
export {
  ASSET_MANIFEST_FIELDS,
  REQUIRED_ASSET_RECORD_FIELDS,
  AssetManifestError,
  type AssetManifestField,
  type AssetState,
  type ApprovalState,
  type QcState,
  type AssetRecord,
  type AssetRecordPatch,
} from "./types.js";

export {
  AssetRepository,
  mapAssetRow,
  type ResolvedAsset,
} from "./asset-repository.js";

export {
  BaseMediaStore,
  type MediaStore,
  type MediaStoreDeps,
  type MediaStoreUploadResult,
  type MediaStoreIngestRequest,
  type ArchiveAssetRequest,
  type ArchivedAsset,
} from "./media-store.js";

export {
  GHL_MEDIA_STORE_KIND,
  GoHighLevelMediaStore,
  GhlMediaStoreConfigurationError,
  type GoHighLevelMediaStoreOptions,
  type GohlMediaStoreOptions,
  type GhlHostedIngest,
  type GhlBinaryIngest,
} from "./gohighlevel-media-store.js";
