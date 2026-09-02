/**
 * GHL asset-link types — CHAR-014 "GHL asset-link refresh/fallback".
 *
 * The canonical identity asset (spec §9, built by CHAR-002) carries durable GHL
 * linkage: `ghlFileId`, `ghlUrl`, `sha256`. Spec: "Canonical GHL file ID + URL +
 * checksum are used verbatim in downstream reference plans and provider calls."
 *
 * This module owns the link lifecycle: resolve (with local-cache-removal
 * fallback to GHL), refresh stale links via the asset manifest, and emit the
 * verbatim triplet into downstream reference plans.
 *
 * The GHL media store is consumed through the {@linkcode GhlMediaStore}
 * interface — read-only; the GHL lane (GHL-002/008/009) owns the real HTTP
 * implementation. Tests inject an in-memory mock.
 */

import type { AssetApprovalState, AssetDimensions } from "../identity-asset/types.js";

/**
 * Read-only view of GHL media storage used to resolve and refresh asset links.
 * The production implementation (GHL lane) talks to the GHL Media API; mocked
 * stores return records from memory.
 */
export interface GhlMediaStore {
  /**
   * Look up the current GHL media record for a file ID. Returns null when GHL
   * reports the file missing/deleted (e.g. after a stale-link detection).
   */
  getMedia(fileId: string): Promise<GhlMediaRecord | null>;
}

/** A single media file record as returned by GHL Media Storage. */
export interface GhlMediaRecord {
  /** GHL media file ID. */
  fileId: string;
  /** Durable GHL URL for the file (verbatim downstream). */
  url: string;
  /** SHA-256 of the stored bytes (lowercase hex). */
  sha256: string;
  /** Owning GHL folder ID. */
  folderId: string | null;
  /** File size in bytes, when GHL reports it. */
  sizeBytes: number | null;
  /** Image dimensions, when GHL reports them. */
  dimensions: AssetDimensions | null;
}

/**
 * The durable asset-link record persisted in the DB/manifest for one identity
 * asset. Mirrors the canonical fields of the identity-asset record (spec §9)
 * plus the identity-version keying so reference plans resolve per version.
 */
export interface AssetLinkRecord {
  /** MMCS asset ID (`IDENT_ASSET_…` style). */
  assetId: string;
  /** Owning character's permanent business ID (`CHAR_…` style). */
  characterId: string;
  /** Identity version this link belongs to (immutable history, spec §9). */
  identityVersion: string;
  /** GHL media file ID — null until archived. */
  ghlFileId: string | null;
  /** Durable GHL URL — null until archived. */
  ghlUrl: string | null;
  /** SHA-256 checksum of the archived bytes — null until archived. */
  sha256: string | null;
  /** Local cache path if present; removal must not invalidate the record. */
  localCachePath: string | null;
  /** Approval state carried for reuse gating (only APPROVED/CANONICAL auto-reuse). */
  approvalState: AssetApprovalState;
  /** Canonical flag — true only for the LOCKED canonical asset. */
  canonical: boolean;
}

/** The verbatim GHL triplet handed to downstream reference plans (spec §9). */
export interface CanonicalAssetLink {
  /** GHL media file ID, verbatim. */
  ghlFileId: string;
  /** Durable GHL URL, verbatim. */
  ghlUrl: string;
  /** SHA-256 checksum, verbatim (lowercase hex). */
  sha256: string;
}

/** Where a resolution sourced the canonical triplet from. */
export type AssetLinkSource =
  | "manifest"
  | "ghl-refresh"
  | "local-cache";

/** Result of resolving an asset link to its canonical triplet. */
export interface AssetLinkResolution {
  /** The verbatim canonical triplet (file ID + URL + checksum). */
  link: CanonicalAssetLink;
  /** Where the triplet came from for this resolution. */
  source: AssetLinkSource;
  /** Local cache path when resolved from a present local cache, else null. */
  localCachePath: string | null;
  /** True when the record's URL was refreshed from GHL during resolution. */
  refreshed: boolean;
}

/** Error thrown when an asset link cannot be resolved or safely refreshed. */
export class AssetLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetLinkError";
  }
}