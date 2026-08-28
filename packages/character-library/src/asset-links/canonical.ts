import {
  AssetLinkError,
  type AssetLinkRecord,
  type CanonicalAssetLink,
} from "./types";

/**
 * Verbatim canonical triplet extraction — spec §9: "Canonical GHL file ID + URL +
 * checksum are used verbatim in downstream reference plans and provider calls."
 *
 * Pure: no I/O, no normalization of the values (verbatim means verbatim — the
 * URL is not rewritten, the file ID is not reformatted, the checksum is not
 * re-encoded).
 */

/** Assert lowercase-hex SHA-256 shape; verbatim passthrough when valid. */
function assertChecksum(sha256: string | null, what: string): string {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new AssetLinkError(
      `${what} has invalid sha256 (${String(sha256)}); expected 64 lowercase hex chars`,
    );
  }
  return sha256;
}

/**
 * Extract the canonical triplet from an asset-link record. Throws
 * {@linkcode AssetLinkError} when the record lacks durable linkage — a
 * downstream reference plan must never receive a partial triplet.
 */
export function requireCanonicalLink(
  record: Pick<AssetLinkRecord, "ghlFileId" | "ghlUrl" | "sha256">,
): CanonicalAssetLink {
  if (!record.ghlFileId) {
    throw new AssetLinkError("asset link lacks ghlFileId (not yet archived)");
  }
  if (!record.ghlUrl) {
    throw new AssetLinkError("asset link lacks ghlUrl (not yet archived)");
  }
  const sha256 = assertChecksum(record.sha256, "asset link");
  return {
    ghlFileId: record.ghlFileId,
    ghlUrl: record.ghlUrl,
    sha256,
  };
}

/** Minimal shape a GHL refresh source must return (subset of GhlMediaRecord). */
export interface GhlRefreshRecord {
  fileId: string;
  url: string;
  sha256: string;
}

/**
 * Validate a triplet returned by a GHL refresh so a corrupt store response can
 * never replace a good canonical record. Same rules as
 * {@linkcode requireCanonicalLink} with refresh-specific error text.
 */
export function validateRefreshedLink(
  record: GhlRefreshRecord,
): CanonicalAssetLink {
  if (!record.fileId) {
    throw new AssetLinkError("refreshed GHL record lacks fileId");
  }
  if (!record.url) {
    throw new AssetLinkError("refreshed GHL record lacks url");
  }
  assertChecksum(record.sha256, "refreshed GHL record");
  return {
    ghlFileId: record.fileId,
    ghlUrl: record.url,
    sha256: record.sha256,
  };
}