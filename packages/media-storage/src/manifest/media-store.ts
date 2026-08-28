/**
 * MediaStore abstraction (spec §17 / §35): the generic durable-media seam the
 * production engine programs against. GoHighLevel is the V1 implementation
 * (`GoHighLevelMediaStore`); later S3/R2/GCS implementations plug in behind
 * this interface without rewriting the engine.
 *
 * Every archival operation is asset-aware: it writes the full spec §19
 * manifest record through `AssetRepository` with the durable-store linkage
 * (`ghlFileId`/`ghlFolderId`/`ghlUrl`) and checksum, so resolution NEVER
 * depends on local files (spec acceptance: resolve after local cache
 * removal passes via DB). The seam is transport-agnostic — callers inject
 * the ingest function (hosted flow from GHL-005, binary fallback from GHL-006,
 * or a fake in tests), keeping this package free of credentials.
 */
import {
  AssetRepository,
  type ResolvedAsset,
} from "./asset-repository.js";
import {
  AssetManifestError,
  type AssetRecord,
  type AssetRecordPatch,
} from "./types.js";

/**
 * Result of one durable-store upload. The MediaStore translates this into
 * the manifest record's durable linkage fields.
 */
export interface MediaStoreUploadResult {
  /** Durable store file ID (GHL: fileId). */
  readonly fileId: string;
  /** Durable store URL (GHL: verified storage URL). */
  readonly url: string;
  /** Durable store folder ID the file landed in (GHL: parentId). */
  readonly folderId: string;
  /** SHA-256 hex checksum of the archived bytes, when the store knows it. */
  readonly checksum?: string;
  /** ISO 8601 instant the durable copy was verified, when the store reports it. */
  readonly verifiedAt?: string;
}

/**
 * One ingest request handed to the store-specific upload function. The
 * MediaStore derives the canonical filename and folder; the implementation
 * does the transport work.
 */
export interface MediaStoreIngestRequest {
  /** Deterministic canonical filename (spec §48). */
  readonly name: string;
  /** Destination folder ID inside the durable store. */
  readonly parentId: string;
  /**
   * Temporary provider URL for hosted ingestion. Binary implementations may
   * also receive the bytes through their own closure instead.
   */
  readonly fileUrl?: string;
  /** Location/sub-account scope (GHL altId), when the caller supplies it. */
  readonly altId?: string;
  readonly altType?: "location" | "agency";
}

/** The generic durable-media seam (spec §35). */
export interface MediaStore {
  /** Stable store kind for logs/wiring: "gohighlevel" today, "s3" later. */
  readonly kind: string;

  /**
   * Archive one asset into the durable store and write its full manifest
   * record. Implementations must verify the durable copy (reachability or
   * integrity) BEFORE returning — an unverified upload never reports ARCHIVED.
   */
  archiveAsset(request: ArchiveAssetRequest): Promise<ArchivedAsset>;

  /** Resolve a durable asset by manifest ID via the DB only. */
  resolveAsset(assetId: string): ResolvedAsset;

  /** Read the manifest record without the resolvability requirement. */
  getAsset(assetId: string): AssetRecord | undefined;

  /** Patch manifest fields (approval/qc transitions, checksum backfill). */
  updateAsset(assetId: string, patch: AssetRecordPatch): AssetRecord | undefined;
}

/** Request for `archiveAsset`. */
export interface ArchiveAssetRequest {
  /** Manifest record fields for the asset (spec §19). Identity fields optional. */
  readonly record: Omit<AssetRecord, "ghlFileId" | "ghlFolderId" | "ghlUrl" | "archivedAt"> & {
    /** Pre-set linkage is honored (idempotent re-archive of a known asset). */
    readonly ghlFileId?: string;
    readonly ghlFolderId?: string;
    readonly ghlUrl?: string;
    readonly archivedAt?: string;
  };
  /**
   * The store-specific ingest operation: hosted URL flow (GHL-005), binary
   * fallback (GHL-006), or a test fake. Receives the canonical name + folder
   * the MediaStore resolved; returns the verified durable result.
   */
  readonly ingest: (
    request: MediaStoreIngestRequest,
  ) => Promise<MediaStoreUploadResult>;
  /** Durable-store folder to file into. Required unless already on the record. */
  readonly parentId?: string;
  /** Location/sub-account scope (GHL altId), when the store needs it. */
  readonly altId?: string;
  readonly altType?: "location" | "agency";
}

/** Result of `archiveAsset`: the persisted manifest record. */
export interface ArchivedAsset {
  readonly record: AssetRecord;
  /** True when the store upload ran this call (false for verified reuse). */
  readonly uploaded: boolean;
}

export interface MediaStoreDeps {
  /** Manifest persistence (spec §19 record lives here, not in filenames). */
  readonly assets: AssetRepository;
  /** ISO clock override for tests. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

/** Shared helpers for MediaStore implementations. */
export abstract class BaseMediaStore implements MediaStore {
  readonly abstract kind: string;

  protected readonly assets: AssetRepository;
  private readonly now: () => string;

  constructor(deps: MediaStoreDeps) {
    this.assets = deps.assets;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async archiveAsset(request: ArchiveAssetRequest): Promise<ArchivedAsset> {
    const record = request.record;
    if (!record || typeof record !== "object") {
      throw new AssetManifestError("INVALID_RECORD", "archiveAsset requires a record object");
    }
    if (typeof record.assetId !== "string" || record.assetId.length === 0) {
      throw new AssetManifestError("MISSING_FIELD", "record.assetId is required");
    }

    // Idempotent reuse: a record that already carries verified durable linkage
    // is not re-uploaded — re-archival must never duplicate the durable copy.
    const existing = this.assets.getById(record.assetId);
    if (
      existing !== undefined &&
      existing.ghlFileId !== undefined &&
      existing.ghlUrl !== undefined
    ) {
      return { record: existing, uploaded: false };
    }

    const folderId = request.parentId ?? record.ghlFolderId;
    if (typeof folderId !== "string" || folderId.length === 0) {
      throw new AssetManifestError("MISSING_FIELD", "parentId (destination folder) is required", {
        assetId: record.assetId,
      });
    }

    // 1. Upload through the injected ingest (hosted flow / binary / fake) and
    //    only trust a result that carries both a file ID and a URL.
    const ingest = request.ingest;
    if (typeof ingest !== "function") {
      throw new AssetManifestError("INVALID_RECORD", "ingest function is required", {
        assetId: record.assetId,
      });
    }
    const upload = await ingest({
      name: record.assetId,
      parentId: folderId,
      ...(record.originalProviderUrl !== undefined ? { fileUrl: record.originalProviderUrl } : {}),
      ...(request.altId !== undefined ? { altId: request.altId } : {}),
      ...(request.altType !== undefined ? { altType: request.altType } : {}),
    });
    if (
      upload === null ||
      typeof upload !== "object" ||
      typeof upload.fileId !== "string" ||
      upload.fileId.length === 0 ||
      typeof upload.url !== "string" ||
      upload.url.length === 0
    ) {
      throw new AssetManifestError(
        "INVALID_RECORD",
        "ingest returned no verified fileId/url — asset is NOT archived",
        { assetId: record.assetId },
      );
    }

    // 2. Write the full manifest record with the durable linkage. An existing
    //    (linkage-less) row is patched; otherwise the record inserts fresh.
    const archivedAt = upload.verifiedAt ?? this.now();
    const manifest: AssetRecord = {
      ...record,
      ghlFileId: upload.fileId,
      ghlFolderId: folderId,
      ghlUrl: upload.url,
      checksum: upload.checksum ?? record.checksum,
      archivedAt,
    };
    const persisted =
      existing !== undefined
        ? (this.assets.update(record.assetId, {
            ghlFileId: upload.fileId,
            ghlFolderId: folderId,
            ghlUrl: upload.url,
            ...(upload.checksum !== undefined ? { checksum: upload.checksum } : {}),
            archivedAt,
          }) as AssetRecord)
        : this.assets.create(manifest);
    return { record: persisted, uploaded: true };
  }

  resolveAsset(assetId: string): ResolvedAsset {
    return this.assets.resolve(assetId);
  }

  getAsset(assetId: string): AssetRecord | undefined {
    return this.assets.getById(assetId);
  }

  updateAsset(assetId: string, patch: AssetRecordPatch): AssetRecord | undefined {
    return this.assets.update(assetId, patch);
  }
}
