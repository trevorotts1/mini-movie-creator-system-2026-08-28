/**
 * GoHighLevelMediaStore — the V1 MediaStore implementation (spec §17/§35).
 *
 * GHL Media Storage is the durable archive; temporary provider URLs are never
 * canonical. The store wires the manifest record (spec §19) to the GHL ingest
 * seams owned by the other WF07 tasks:
 *
 * - hosted URL ingest (GHL-005, `ghl/upload-hosted`): POST /medias/upload-file
 *   with hosted=true + fileUrl; verified reachability before ARCHIVED;
 * - binary fallback (GHL-006, `ghl/upload-binary`): download → checksum →
 *   verify → upload → integrity compare; checksum flows into the manifest;
 * - idempotent retry (GHL-011, `ghl/retry`): the caller may wrap `ingest`
 *   with `withArchivalIdempotency`; this module never re-uploads a record
 *   that already carries verified linkage.
 *
 * Like every manifest module, transport is injected — no credentials here
 * (GHL-001 owns auth). The GHL-specific dependencies arrive as structural
 * interfaces (the `GhlIngestFn` shape matches `archiveHostedUrl`'s contract
 * and the binary uploader's `archive`), so this package compiles and tests
 * green whether or not those sibling tasks have merged yet.
 */
import { BaseMediaStore, type MediaStoreDeps, type MediaStoreUploadResult } from "./media-store.js";

/** Stable store kind for this implementation. */
export const GHL_MEDIA_STORE_KIND = "gohighlevel";

/**
 * Structural ingest contract for the hosted flow: the same shape as
 * `archiveHostedUrl(http, request, options)` with the transport bound
 * (GHL-005). Returns the verified fileId + storage URL.
 */
export type GhlHostedIngest = (request: {
  fileUrl: string;
  name: string;
  parentId: string;
  altId?: string;
  altType?: "location" | "agency";
}) => Promise<{ fileId: string; url: string; name?: string; raw?: unknown }>;

/**
 * Structural ingest contract for the binary fallback: `BinaryFallbackUploader
 * .archive(input)` with the client bound (GHL-006). Returns the verified
 * fileId + URL + the SHA-256 of the bytes it archived.
 */
export type GhlBinaryIngest = (input: {
  providerUrl: string;
  name: string;
  parentId: string;
  locationId: string;
}) => Promise<{ fileId: string; url: string; sourceChecksum: string; verifiedChecksum: string }>;

export interface GoHighLevelMediaStoreOptions {
  /** GHL location (sub-account) ID used as altId on hosted ingests. */
  readonly locationId: string;
  /** Hosted-flow ingest (GHL-005 with transport bound). */
  readonly hostedIngest?: GhlHostedIngest;
  /** Binary-fallback ingest (GHL-006 with client bound). */
  readonly binaryIngest?: GhlBinaryIngest;
  /** Manifest persistence + clock. */
  readonly deps: MediaStoreDeps;
  /**
   * Prefer hosted ingestion (spec §35.3: remote copy before URL expiry).
   * When true (default) a request carrying `originalProviderUrl` with no
   * hosted ingest wired throws instead of silently falling back — explicit
   * configuration over accidental paths.
   */
  readonly preferHosted?: boolean;
}

/** Backwards-compatible alias for earlier typo. */
export type GohlMediaStoreOptions = GoHighLevelMediaStoreOptions;

export class GhlMediaStoreConfigurationError extends Error {
  constructor(missing: string) {
    super(
      `GoHighLevelMediaStore is not configured for ${missing}; wire the GHL-005 hosted ingest and/or GHL-006 binary ingest at construction`,
    );
    this.name = "GhlMediaStoreConfigurationError";
  }
}

/**
 * GHL-backed MediaStore. Manifest records always land in the DB with
 * ghl_file_id / ghl_folder_id / ghl_url and (binary path) the checksum.
 */
export class GoHighLevelMediaStore extends BaseMediaStore {
  readonly kind = GHL_MEDIA_STORE_KIND;

  private readonly locationId: string;
  private readonly hostedIngest?: GhlHostedIngest;
  private readonly binaryIngest?: GhlBinaryIngest;
  private readonly preferHosted: boolean;

  constructor(options: GoHighLevelMediaStoreOptions) {
    super(options.deps);
    if (typeof options.locationId !== "string" || options.locationId.length === 0) {
      throw new GhlMediaStoreConfigurationError("locationId");
    }
    this.locationId = options.locationId;
    this.hostedIngest = options.hostedIngest;
    this.binaryIngest = options.binaryIngest;
    this.preferHosted = options.preferHosted ?? true;
  }

  /**
   * Ingest selection for `archiveAsset`'s `ingest` slot (spec §35.3):
   * hosted first (remote copy before provider URL expiry), binary fallback
   * when hosted is absent/fails, and the checksum from the binary path flows
   * into the manifest record.
   */
  ingestFor(request: { originalProviderUrl?: string }): (ingestRequest: {
    name: string;
    parentId: string;
    fileUrl?: string;
    altId?: string;
    altType?: "location" | "agency";
  }) => Promise<MediaStoreUploadResult> {
    return async (ingestRequest) => {
      const hostedWired =
        this.hostedIngest !== undefined &&
        (ingestRequest.fileUrl !== undefined || request.originalProviderUrl !== undefined);
      const binaryWired = this.binaryIngest !== undefined;

      if (hostedWired && this.preferHosted) {
        try {
          const result = await this.hostedIngest?.({
            fileUrl: (ingestRequest.fileUrl ?? request.originalProviderUrl) as string,
            name: ingestRequest.name,
            parentId: ingestRequest.parentId,
            altId: ingestRequest.altId ?? this.locationId,
            altType: ingestRequest.altType ?? "location",
          });
          if (result !== undefined) {
            return {
              fileId: result.fileId,
              url: result.url,
              folderId: ingestRequest.parentId,
            };
          }
        } catch {
          // spec §35.3: hosted ingest failure falls back to the binary path
          // when wired — never propagate and lose the only copy of a paid asset.
          if (!binaryWired) {
            throw new GhlMediaStoreConfigurationError(
              "a working hosted ingest (hosted ingest failed and no binary fallback is wired)",
            );
          }
          // fall through to the binary ingest below
        }
        if (!binaryWired) {
          throw new GhlMediaStoreConfigurationError(
            "a working hosted ingest (hosted ingest returned no result and no binary fallback is wired)",
          );
        }
      }

      if (!binaryWired) {
        throw new GhlMediaStoreConfigurationError(
          "any ingest (hosted ingest not wired for this asset and no binary fallback is wired)",
        );
      }

      const providerUrl = ingestRequest.fileUrl ?? request.originalProviderUrl;
      if (providerUrl === undefined) {
        throw new GhlMediaStoreConfigurationError(
          "a provider URL (binary fallback downloads the bytes; nothing to download)",
        );
      }
      const binary = await this.binaryIngest({
        providerUrl,
        name: ingestRequest.name,
        parentId: ingestRequest.parentId,
        locationId: ingestRequest.altId ?? this.locationId,
      });
      if (binary.sourceChecksum !== binary.verifiedChecksum) {
        throw new Error(
          `GHL binary ingest integrity mismatch: source ${binary.sourceChecksum} vs verified ${binary.verifiedChecksum}`,
        );
      }
      return {
        fileId: binary.fileId,
        url: binary.url,
        folderId: ingestRequest.parentId,
        checksum: binary.verifiedChecksum,
      };
    };
  }
}
