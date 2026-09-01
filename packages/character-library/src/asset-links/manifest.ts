import { AssetLinkError, type CanonicalAssetLink, type GhlMediaStore } from "./types.js";
import { validateRefreshedLink } from "./canonical.js";

/**
 * Asset manifest — the durable DB/manifest side of asset-link storage
 * (spec §19: "Every media asset has a durable DB record … never filenames/
 * folders alone"). CHAR-014 consumes it read/write for link records only;
 * the manifest integration itself is GHL-008's `media-storage/src/manifest.ts`.
 */

/** A manifest entry carrying the durable asset link for one identity asset. */
export interface AssetManifestEntry {
  /** MMCS asset ID (primary key for link lookup). */
  assetId: string;
  /** The durable link record as last persisted. */
  link: CanonicalAssetLink & {
    /** Local cache path at persist time (null when cache removed). */
    localCachePath: string | null;
  };
}

/** Storage contract for asset manifest entries (in-memory in tests). */
export interface AssetManifestStore {
  /** Load the manifest entry for an asset ID, or null when absent. */
  load(assetId: string): Promise<AssetManifestEntry | null>;
  /** Persist (upsert) the manifest entry for an asset ID. */
  save(entry: AssetManifestEntry): Promise<void>;
}

/** Read-only view of a manifest that has already been loaded into memory. */
export class InMemoryAssetManifest implements AssetManifestStore {
  private readonly entries = new Map<string, AssetManifestEntry>();

  constructor(entries: readonly AssetManifestEntry[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.assetId, entry);
    }
  }

  async load(assetId: string): Promise<AssetManifestEntry | null> {
    return this.entries.get(assetId) ?? null;
  }

  async save(entry: AssetManifestEntry): Promise<void> {
    this.entries.set(entry.assetId, entry);
  }
}

/**
 * Refresh a stale asset link against GHL (spec §14.4 / §35.3 pattern: never
 * regenerate — re-verify). Loads the manifest entry, re-reads the current GHL
 * media record for the stored file ID, validates the returned record, persists
 * the refreshed URL/checksum back to the manifest, and returns the canonical
 * triplet.
 *
 * Throws {@linkcode AssetLinkError} when the manifest has no entry, the entry
 * lacks a file ID, or GHL reports the file missing (nothing to refresh from —
 * the record must never be silently rewritten with a fabricated link).
 */
export async function refreshStaleLink(
  assetId: string,
  manifest: AssetManifestStore,
  ghl: GhlMediaStore,
): Promise<CanonicalAssetLink> {
  const entry = await manifest.load(assetId);
  if (!entry) {
    throw new AssetLinkError(
      `asset manifest has no entry for ${assetId}; cannot refresh`,
    );
  }
  if (!entry.link.ghlFileId) {
    throw new AssetLinkError(
      `manifest entry for ${assetId} lacks ghlFileId; cannot refresh`,
    );
  }
  const media = await ghl.getMedia(entry.link.ghlFileId);
  if (!media) {
    throw new AssetLinkError(
      `GHL reports file ${entry.link.ghlFileId} missing; cannot refresh link for ${assetId}`,
    );
  }
  const refreshed = validateRefreshedLink(media);
  await manifest.save({
    assetId: entry.assetId,
    link: {
      ghlFileId: refreshed.ghlFileId,
      ghlUrl: refreshed.ghlUrl,
      sha256: refreshed.sha256,
      localCachePath: entry.link.localCachePath,
    },
  });
  return refreshed;
}