/**
 * Binary fallback upload orchestrator — spec §17.4 step 4.
 *
 * Runs ONLY when hosted ingestion (GHL-005) fails. Sequence, in order:
 *   0. validate the provider URL (SKR-025: https-only, no private/metadata
 *      host, no embedded credentials) before any fetch;
 *   1. download immediately from the provider temporary URL (never regenerate);
 *   2. enforce MIME + size limits — 25 MB general / 500 MB video — BEFORE any
 *      further work, via the shared `validate.ts` guard;
 *   3. checksum (SHA-256) the downloaded bytes;
 *   4. ffprobe/decode verify locally;
 *   5. binary upload to POST /medias/upload-file with the sanitized name;
 *   6. verify the returned fileId AND storage URL (reachable);
 *   7. integrity-compare (re-download from GHL, checksum equality) and only
 *      then report ARCHIVED.
 *
 * Any failure at any step throws UploadError with a machine-readable reason;
 * the provider URL/job stays persisted upstream — regeneration is never this
 * function's business.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GhlUploadError,
  type GhlUploadClient,
  type VerifyUrlResult,
} from "./client.js";
import { contentTypeForName, type MediaKind } from "./media-kind.js";
import { limitForKind } from "./limits.js";
import { FfprobeVerifier, type MediaVerifier } from "./verify.js";
import {
  MEDIA_CATEGORIES,
  ValidationError,
  checkFilename,
  normalizeMimeType,
  mimeCategory,
  validateMediaFile,
  validateRemoteUrl,
  type MediaCategory,
} from "../validation/index.js";

export type {
  DownloadedFile,
  DownloadRequest,
  BinaryUploadInput,
  GhlUploadResult,
  GhlUploadClient,
  VerifyUrlResult,
} from "./client.js";
export { GhlUploadError, downloadBytes } from "./client.js";
export { contentTypeForName, type MediaKind } from "./media-kind.js";
export { GENERAL_LIMIT_BYTES, VIDEO_LIMIT_BYTES, limitForKind } from "./limits.js";
export { FfprobeVerifier, DecodeError, type MediaVerifier, type ProbeResult } from "./verify.js";

/** SHA-256 hex digest of bytes. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BinaryFallbackInput {
  /** Provider temporary URL (already failed hosted ingestion upstream). */
  providerUrl: string;
  /** Deterministic canonical filename (spec §19). */
  name: string;
  /** GHL destination folder ID. */
  parentId: string;
  /** GHL location (sub-account) ID. */
  locationId: string;
  /** Media kind drives size limit + verification strategy. */
  kind: MediaKind;
  /** Optional verifier override (tests inject fakes; default FfprobeVerifier). */
  verifier?: MediaVerifier;
  /** AbortSignal propagated to fetches. */
  signal?: AbortSignal;
}

export interface BinaryFallbackResult {
  state: "ARCHIVED";
  fileId: string;
  url: string;
  /** SHA-256 of the source bytes (what we downloaded). */
  sourceChecksum: string;
  /** SHA-256 of what GHL served back during integrity verification. */
  verifiedChecksum: string;
  bytes: number;
  kind: MediaKind;
}

export interface BinaryFallbackOptions {
  client: GhlUploadClient;
  verifier?: MediaVerifier;
}

export class BinaryFallbackUploader {
  private readonly client: GhlUploadClient;
  private readonly verifier: MediaVerifier;

  constructor(options: BinaryFallbackOptions) {
    this.client = options.client;
    this.verifier = options.verifier ?? new FfprobeVerifier();
  }

  async archive(input: BinaryFallbackInput): Promise<BinaryFallbackResult> {
    const limit = limitForKind(input.kind);

    // 0. Guard the provider URL before touching the network (SKR-025): a
    //    scheme/host guard that is never called is not a guard. Refuse
    //    non-HTTPS and private/metadata/link-local hosts (SSRF).
    try {
      validateRemoteUrl(input.providerUrl);
    } catch (cause) {
      throw new GhlUploadError("disallowed-url", describeValidationFailure(cause));
    }

    // The stored name is the spec §19 canonical filename; sanitize it before it
    // reaches the multipart form (flat, traversal-free) — the same guard the
    // validation module claims uploaders call.
    const name = sanitizedName(input.name);

    // 1. Download immediately — the provider URL can expire at any moment.
    let downloaded;
    try {
      downloaded = await this.client.downloadFile({
        url: input.providerUrl,
        signal: input.signal,
      });
    } catch (cause) {
      throw new GhlUploadError(
        "download-failed",
        `Failed to download ${input.providerUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 2. MIME + size gate BEFORE checksum/decode/upload. An expired provider
    //    URL can answer with an empty body, and archiving that would destroy
    //    the only copy of a paid asset.
    validateDownloadedMedia(downloaded, name, input.kind, limit);

    // 3. Checksum the source bytes.
    const sourceChecksum = sha256Hex(downloaded.data);

    // 4. ffprobe/decode verify locally (temp file, argv-only commands).
    const verifier = input.verifier ?? this.verifier;
    const dir = await mkdtemp(join(tmpdir(), "mmcs-ghl-upload-"));
    try {
      const filePath = join(dir, safeTempName(name));
      await writeFile(filePath, downloaded.data);
      try {
        await verifier.verify(filePath, input.kind);
      } catch (cause) {
        if (cause instanceof GhlUploadError) throw cause;
        throw new GhlUploadError(
          "decode-failed",
          `Local decode verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // 5. Binary upload.
    let uploaded: { fileId: string; url: string };
    try {
      uploaded = await this.client.uploadBinary({
        name,
        parentId: input.parentId,
        locationId: input.locationId,
        data: downloaded.data,
        contentType: contentTypeForName(name),
      });
    } catch (cause) {
      if (cause instanceof GhlUploadError) throw cause;
      throw new GhlUploadError(
        "upload-failed",
        `GHL binary upload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!uploaded.fileId || !uploaded.url) {
      throw new GhlUploadError(
        "missing-id-or-url",
        "GHL upload response did not include fileId and url",
      );
    }

    // 6. Verify the returned storage URL is reachable.
    let verification: VerifyUrlResult;
    try {
      verification = await this.client.verifyUrl(uploaded.url);
    } catch (cause) {
      throw new GhlUploadError(
        "url-unreachable",
        `Verifying GHL URL failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!verification.reachable) {
      throw new GhlUploadError(
        "url-unreachable",
        `GHL URL ${uploaded.url} is not reachable after upload`,
      );
    }

    // 7. Integrity compare: bytes GHL serves back must hash identical.
    let roundTrip: Uint8Array;
    try {
      roundTrip = await this.client.downloadFile({
        url: verification.servedUrl ?? uploaded.url,
        signal: input.signal,
      }).then((d) => d.data);
    } catch (cause) {
      throw new GhlUploadError(
        "integrity-failed",
        `Downloading back from GHL failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const verifiedChecksum = sha256Hex(roundTrip);
    if (verifiedChecksum !== sourceChecksum) {
      throw new GhlUploadError(
        "integrity-failed",
        `Checksum mismatch after upload: source ${sourceChecksum} vs stored ${verifiedChecksum}`,
      );
    }

    // Only now — every gate passed — is the asset ARCHIVED.
    return {
      state: "ARCHIVED",
      fileId: uploaded.fileId,
      url: uploaded.url,
      sourceChecksum,
      verifiedChecksum,
      bytes: downloaded.data.byteLength,
      kind: input.kind,
    };
  }
}

/**
 * Convenience one-shot runner.
 */
export async function archiveViaBinaryFallback(
  input: BinaryFallbackInput,
  options: BinaryFallbackOptions,
): Promise<BinaryFallbackResult> {
  return new BinaryFallbackUploader(options).archive(input);
}

/** Temp file name for the local decode-verify pass: basename only, no traversal. */
function safeTempName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "asset.bin";
  if (base.length === 0 || base === "." || base === "..") return "asset.bin";
  return base;
}

/**
 * Sanitize the canonical filename before it is used as a stored name or as a
 * local temp-file stem (SKR-025): `checkFilename` strips path components,
 * traversal, control characters and reserved device names. Refusing is better
 * than uploading an unsanitizable name.
 */
function sanitizedName(raw: string): string {
  try {
    return checkFilename(raw, "asset.bin").filename;
  } catch (cause) {
    throw new GhlUploadError(
      "invalid-name",
      `file name cannot be sanitized for upload: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Human-readable form of a `validate.ts` failure (never includes a token). */
function describeValidationFailure(cause: unknown): string {
  if (cause instanceof ValidationError) {
    return cause.detail === undefined ? cause.message : `${cause.message} (${cause.detail})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Content types servers use when they do not know (or do not care about) the
 * real type. These fall back to the filename extension; any OTHER non-media
 * declared type is refused.
 */
const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/x-unknown",
]);

/**
 * The MIME + size gate for downloaded bytes (spec §17.4 step 4), wired to the
 * shared validators that previously had no production caller (SKR-025).
 *
 * MIME resolution order: a declared media type is validated as-is; a declared
 * GENERIC type (or none at all) falls back to the canonical filename
 * extension, because providers commonly answer `application/octet-stream` for
 * a perfectly good MP4; a declared type that is neither media nor generic
 * (e.g. `application/pdf`) is refused.
 */
function validateDownloadedMedia(
  downloaded: { data: Uint8Array; contentType?: string },
  name: string,
  kind: MediaKind,
  limit: number,
): void {
  const declared = normalizeMimeType(downloaded.contentType);
  const isGeneric = declared.length === 0 || GENERIC_CONTENT_TYPES.has(declared);
  const usableMime = isGeneric && mimeCategory(declared) === null ? undefined : declared;
  const allowedCategories: readonly MediaCategory[] =
    kind === "generic" ? MEDIA_CATEGORIES : [kind];
  try {
    validateMediaFile(usableMime, downloaded.data.byteLength, {
      filename: name,
      allowedCategories,
      maxBytes: limit,
    });
  } catch (cause) {
    const code = cause instanceof ValidationError ? cause.code : undefined;
    if (code === "FILE_EMPTY") {
      // Preserved reason: callers branch on "download-failed" for the
      // expired-provider-URL empty-body case.
      throw new GhlUploadError("download-failed", "Downloaded 0 bytes (empty body)");
    }
    if (code === "FILE_TOO_LARGE") {
      throw new GhlUploadError(
        "size-limit",
        `File is ${downloaded.data.byteLength} bytes; limit for ${kind} is ${limit}`,
      );
    }
    throw new GhlUploadError(
      "mime-type",
      `file is not an accepted ${kind} media file: ${describeValidationFailure(cause)}`,
    );
  }
}