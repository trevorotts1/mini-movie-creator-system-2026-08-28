import type { AssetDimensions } from "./types.js";

/**
 * Local cache registration for a canonical identity asset (spec §9: "local cache
 * path if present"). Canonical linkage is durable in GHL — removing the local
 * cache must not invalidate the record, so clearing only nulls the cache path
 * and resolution falls back to the durable GHL URL + file ID.
 */

/** A registered local cache entry for an asset's media bytes. */
export interface LocalAssetCache {
  /** Path of the cached media file (absolute or workspace-relative). */
  path: string;
  /** SHA-256 of the cached bytes (lowercase hex); must match the asset record. */
  sha256: string;
  /** Cached file size in bytes. */
  sizeBytes: number;
  /** Cached image dimensions. */
  dimensions: AssetDimensions;
}

/** Result of resolving an asset's media: local-cache hit or durable GHL fallback. */
export interface AssetResolution {
  /** Where the media came from for this resolution. */
  source: "local-cache" | "ghl";
  /** Path if local-cache hit, otherwise null. */
  localCachePath: string | null;
  /** Durable GHL URL used verbatim (always present; spec §9). */
  ghlUrl: string;
  /** GHL file ID used verbatim (always present; spec §9). */
  ghlFileId: string;
}

/** Register a local cache entry; validates hash format and size (no I/O). */
export function registerLocalCache(input: {
  path: string;
  sha256: string;
  sizeBytes: number;
  dimensions: AssetDimensions;
}): LocalAssetCache {
  if (!input.path || input.path.trim().length === 0) {
    throw new Error("localCachePath must be a non-empty string");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error(`sha256 must be 64 hex chars, got: ${input.sha256}`);
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error(`invalid sizeBytes: ${String(input.sizeBytes)}`);
  }
  return {
    path: input.path,
    sha256: input.sha256.toLowerCase(),
    sizeBytes: input.sizeBytes,
    dimensions: { ...input.dimensions },
  };
}

/** Clear the local cache from an asset record; GHL linkage stays intact. */
export function clearLocalCache<T extends { localCachePath: string | null }>(
  asset: T,
): T {
  return { ...asset, localCachePath: null };
}

/**
 * Resolve media for an asset: local cache when the path is present, otherwise
 * the durable GHL URL + file ID (spec: "resolve the canonical asset via DB
 * after local cache removal"). Pure — performs no I/O.
 */
export function resolveAssetMedia<T extends {
  ghlFileId: string | null;
  ghlUrl: string | null;
  localCachePath: string | null;
  sha256: string | null;
}>(
  asset: T,
  cache?: Pick<LocalAssetCache, "path" | "sha256"> | null,
): AssetResolution {
  if (!asset.ghlFileId || !asset.ghlUrl) {
    throw new Error("asset lacks durable GHL linkage (ghlFileId/ghlUrl)");
  }
  if (
    asset.localCachePath &&
    cache &&
    cache.path === asset.localCachePath &&
    (!asset.sha256 || cache.sha256 === asset.sha256)
  ) {
    return {
      source: "local-cache",
      localCachePath: asset.localCachePath,
      ghlUrl: asset.ghlUrl,
      ghlFileId: asset.ghlFileId,
    };
  }
  return {
    source: "ghl",
    localCachePath: null,
    ghlUrl: asset.ghlUrl,
    ghlFileId: asset.ghlFileId,
  };
}