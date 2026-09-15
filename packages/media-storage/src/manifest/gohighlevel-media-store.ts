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
import {
  BaseMediaStore,
  type ArchiveAssetRequest,
  type ArchivedAsset,
  type MediaStoreDeps,
  type MediaStoreIngestRequest,
  type MediaStoreUploadResult,
} from "./media-store.js";
import { GhlLocationMismatchError, requireLocationId } from "../ghl/tenant.js";
import {
  withArchivalIdempotency,
  type ArchivalIdempotencyOptions,
} from "../ghl/retry/idempotent-archival.js";
import type { ArchivalLedger } from "../ghl/retry/ledger.js";

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
  /**
   * Durable GHL-011 idempotency ledger (SKR-013). When wired, every ingest in
   * this store runs under `withArchivalIdempotency`, so a retry after a lost
   * success response reuses the recorded GHL file instead of POSTing a second
   * copy. This is the manifest store actually using the ledger that already
   * existed beside it.
   */
  readonly ledger?: ArchivalLedger;
  /**
   * Provider-side "does this canonical name already exist in this folder?"
   * lookup — the GHL-002 list call scoped to one parent folder. Optional, but
   * it is what makes dedupe-by-name possible before POST and what lets a held
   * (crash-window) archival reservation be resolved instead of refused.
   * Returning null means "verified absent at GHL", so it must be backed by a
   * real listing call, never a guess.
   */
  readonly findExistingFile?: (query: {
    altId: string;
    parentId: string;
    name: string;
  }) => Promise<{ fileId: string; url: string } | null>;
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
 * ghl_file_id / ghl_folder_id / ghl_url / ghl_location_id and (binary path)
 * the checksum.
 */
export class GoHighLevelMediaStore extends BaseMediaStore {
  readonly kind = GHL_MEDIA_STORE_KIND;

  private readonly locationId: string;
  private readonly hostedIngest?: GhlHostedIngest;
  private readonly binaryIngest?: GhlBinaryIngest;
  private readonly preferHosted: boolean;
  private readonly ledger?: ArchivalLedger;
  private readonly findExistingFile?: GoHighLevelMediaStoreOptions["findExistingFile"];

  constructor(options: GoHighLevelMediaStoreOptions) {
    super(options.deps);
    // A blank location is a misconfiguration, not a default: this store writes
    // every record's tenant column from this value (SKR-011).
    if (typeof options.locationId !== "string" || options.locationId.trim().length === 0) {
      throw new GhlMediaStoreConfigurationError("locationId");
    }
    this.locationId = options.locationId.trim();
    this.hostedIngest = options.hostedIngest;
    this.binaryIngest = options.binaryIngest;
    this.preferHosted = options.preferHosted ?? true;
    this.ledger = options.ledger;
    this.findExistingFile = options.findExistingFile;
    // NOTE: a ledger without findExistingFile is deliberately ACCEPTED. A held
    // reservation then raises ArchivalReservationHeldError naming exactly what
    // to do ("wire detectExisting, or release the key once the file is confirmed
    // absent at GHL") rather than resolving itself. That is correct: the outcome
    // of the earlier attempt is unknown and may have landed, so releasing on a
    // guess is how one paid archival becomes two — the very duplicate the ledger
    // exists to prevent. A completed ledger record needs no detector at all.
  }

  /**
   * Archive one asset with tenant isolation (SKR-011), pre-POST dedupe
   * (SKR-013) and — when a ledger is wired — lost-success protection.
   *
   * The store is bound to exactly one GHL location, because the credential it
   * uses is: accepting a caller-supplied location that differs is the tenant
   * leak this override exists to refuse.
   */
  override async archiveAsset(request: ArchiveAssetRequest): Promise<ArchivedAsset> {
    const requestedLocation =
      request.altId === undefined
        ? request.record.ghlLocationId
        : requireLocationId(request.altId, "altId");
    if (requestedLocation !== undefined && requestedLocation !== this.locationId) {
      throw new GhlLocationMismatchError(
        `GHL media store (bound to location "${this.locationId}")`,
        this.locationId,
        requestedLocation,
        "ingest media",
      );
    }
    const tenantScoped: ArchiveAssetRequest = {
      ...request,
      record: { ...request.record, ghlLocationId: this.locationId },
      altId: this.locationId,
    };

    let reusedFromLedger = false;
    const ledger = this.ledger;
    const dedupeByName = this.findExistingFile;
    const ingest = async (ingestRequest: MediaStoreIngestRequest): Promise<MediaStoreUploadResult> => {
      const byName = async (): Promise<{ fileId: string; url: string } | null> =>
        dedupeByName === undefined
          ? null
          : dedupeByName({
              altId: this.locationId,
              parentId: ingestRequest.parentId,
              name: ingestRequest.name,
            });
      // Dedupe by canonical name BEFORE the POST: the deterministic filename
      // (spec §35.3/§48) makes an already-archived asset findable, so a re-run
      // adopts it instead of creating a duplicate GHL file. This runs whether
      // or not a ledger is wired.
      const attempt = async (): Promise<MediaStoreUploadResult> => {
        const existing = await byName();
        if (existing !== null) {
          return {
            fileId: existing.fileId,
            url: existing.url,
            folderId: ingestRequest.parentId,
            ...(request.record.checksum !== undefined
              ? { checksum: request.record.checksum }
              : {}),
          };
        }
        return request.ingest(ingestRequest);
      };
      if (ledger === undefined) return attempt();

      const idempotencyOptions: ArchivalIdempotencyOptions<MediaStoreUploadResult> =
        dedupeByName === undefined
          ? {}
          : {
              // A held reservation means an earlier attempt's outcome is
              // unknown (it may have landed at GHL). Resolve it provider-side
              // by name; without that lookup the module refuses to re-POST
              // rather than risk a duplicate.
              detectExisting: async (): Promise<MediaStoreUploadResult | null> => {
                const found = await byName();
                if (found === null) return null;
                return { fileId: found.fileId, url: found.url, folderId: ingestRequest.parentId };
              },
            };
      const outcome = await withArchivalIdempotency<MediaStoreUploadResult>(
        ledger,
        {
          altId: this.locationId,
          parentId: ingestRequest.parentId,
          name: ingestRequest.name,
          ...(request.record.checksum !== undefined
            ? { checksum: request.record.checksum }
            : {}),
          ...(ingestRequest.fileUrl !== undefined ? { fileUrl: ingestRequest.fileUrl } : {}),
          ...(request.record.providerTaskId !== undefined
            ? { providerTaskId: request.record.providerTaskId }
            : {}),
        },
        attempt,
        idempotencyOptions,
      );
      if (outcome.reused) reusedFromLedger = true;
      return outcome.value;
    };

    const archived = await super.archiveAsset({ ...tenantScoped, ingest });
    return reusedFromLedger ? { ...archived, uploaded: false } : archived;
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
