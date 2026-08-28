import type {
  AssetLinkRecord,
  AssetLinkResolution,
  GhlMediaStore,
} from "./types";
import { AssetLinkError } from "./types";
import { requireCanonicalLink, validateRefreshedLink } from "./canonical";
import { refreshStaleLink, type AssetManifestStore } from "./manifest";

/**
 * Asset-link resolution — spec §9 / acceptance gate 13: "resolve the canonical
 * asset via DB after local cache removal" and "exact canonical GHL URL/file ID
 * used in the downstream reference plan".
 *
 * Resolution order:
 * 1. Local cache hit — record carries a cache path, the caller confirms the
 *    cache is present (path + checksum match), and the record has durable
 *    linkage. Returns the triplet with the cache path attached.
 * 2. Durable DB/manifest record — the verbatim triplet as persisted.
 * 3. GHL refresh — when `refreshOnStale` is set and the record's URL is absent
 *    or the caller flags the link stale, re-read the current GHL media record
 *    and rewrite the record. Never fabricates a link.
 */

/** Options for {@linkcode resolveAssetLink}. */
export interface ResolveAssetLinkOptions {
  /**
   * Confirm a present local cache: path + sha256 of the actual cached bytes.
   * When omitted, or when the path/checksum do not match the record, resolution
   * falls back to the durable GHL link (local-cache-removal path).
   */
  localCache?: { path: string; sha256: string } | null;
  /** Allow a GHL round-trip when the record is stale/incomplete. */
  refreshOnStale?: boolean;
}

/**
 * Resolve an asset link to the canonical verbatim triplet.
 *
 * Throws {@linkcode AssetLinkError} when the record has no durable linkage and
 * no refresh source can produce one (downstream reference plans must never see
 * a partial triplet).
 */
export async function resolveAssetLink(
  record: AssetLinkRecord,
  manifest: AssetManifestStore,
  ghl: GhlMediaStore,
  options: ResolveAssetLinkOptions = {},
): Promise<AssetLinkResolution> {
  const durable =
    record.ghlFileId && record.ghlUrl && record.sha256
      ? requireCanonicalLink(record)
      : null;

  if (
    durable &&
    record.localCachePath &&
    options.localCache?.path === record.localCachePath &&
    (!record.sha256 || options.localCache.sha256 === record.sha256)
  ) {
    return {
      link: durable,
      source: "local-cache",
      localCachePath: record.localCachePath,
      refreshed: false,
    };
  }

  if (durable) {
    return {
      link: durable,
      source: "manifest",
      localCachePath: null,
      refreshed: false,
    };
  }

  if (options.refreshOnStale) {
    const refreshed = await refreshStaleLink(record.assetId, manifest, ghl);
    return {
      link: refreshed,
      source: "ghl-refresh",
      localCachePath: null,
      refreshed: true,
    };
  }

  throw new AssetLinkError(
    `asset ${record.assetId} lacks durable GHL linkage (ghlFileId/ghlUrl/sha256); ` +
      "refusing to hand a partial link to downstream reference plans",
  );
}

/**
 * Re-verify a resolved link's URL against GHL and rewrite the record when GHL
 * reports different durable values (stale-link refresh via manifest). Returns
 * the updated record; the caller persists it in its own store.
 */
export async function refreshAssetLink(
  record: AssetLinkRecord,
  manifest: AssetManifestStore,
  ghl: GhlMediaStore,
): Promise<AssetLinkRecord> {
  if (!record.ghlFileId) {
    throw new AssetLinkError(
      `asset ${record.assetId} lacks ghlFileId; cannot refresh against GHL`,
    );
  }
  const media = await ghl.getMedia(record.ghlFileId);
  if (!media) {
    throw new AssetLinkError(
      `GHL reports file ${record.ghlFileId} missing; cannot refresh link for ${record.assetId}`,
    );
  }
  const refreshed = validateRefreshedLink(media);
  return {
    ...record,
    ghlFileId: refreshed.ghlFileId,
    ghlUrl: refreshed.ghlUrl,
    sha256: refreshed.sha256,
  };
}