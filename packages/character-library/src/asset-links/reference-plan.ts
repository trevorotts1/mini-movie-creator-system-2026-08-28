import type {
  AssetLinkRecord,
  AssetLinkResolution,
  CanonicalAssetLink,
} from "./types.js";
import { requireCanonicalLink } from "./canonical.js";
import type { AssetManifestStore } from "./manifest.js";
import { resolveAssetLink, type ResolveAssetLinkOptions } from "./resolve.js";

/**
 * Downstream reference-plan handoff — spec §9: "Canonical GHL file ID + URL +
 * checksum are used verbatim in downstream reference plans and provider calls."
 *
 * A reference plan entry is what DIR-012/DIR-013 and the provider request
 * builders consume. The triplet here is never rewritten: whatever GHL
 * returned at archive/refresh time is exactly what a provider call receives.
 */

/** One character-asset entry of a downstream reference plan. */
export interface ReferencePlanAsset {
  /** Owning character's permanent business ID. */
  characterId: string;
  /** Identity version this reference belongs to (immutable history). */
  identityVersion: string;
  /** GHL media file ID, verbatim. */
  ghlFileId: string;
  /** Durable GHL URL, verbatim. */
  ghlUrl: string;
  /** SHA-256 checksum, verbatim (lowercase hex). */
  sha256: string;
  /** Resolution source (local-cache | manifest | ghl-refresh). */
  resolvedFrom: AssetLinkResolution["source"];
  /** Local cache path when the media is served from cache, else null. */
  localCachePath: string | null;
}

/**
 * Build a downstream reference-plan asset entry from an asset-link record.
 * Sync, pure; throws {@linkcode AssetLinkError} when the record lacks durable
 * linkage (use the async {@linkcode resolveAssetLink} first when a refresh may
 * be needed).
 */
export function toReferencePlanAsset(
  record: AssetLinkRecord,
): ReferencePlanAsset {
  const link = requireCanonicalLink(record);
  return {
    characterId: record.characterId,
    identityVersion: record.identityVersion,
    ghlFileId: link.ghlFileId,
    ghlUrl: link.ghlUrl,
    sha256: link.sha256,
    resolvedFrom: record.localCachePath ? "local-cache" : "manifest",
    localCachePath: record.localCachePath,
  };
}

/**
 * Build a reference-plan asset entry with full resolution (local-cache check +
 * optional stale refresh). See {@linkcode resolveAssetLink} for options.
 */
export async function resolveReferencePlanAsset(
  record: AssetLinkRecord,
  manifest: AssetManifestStore,
  ghl: import("./types").GhlMediaStore,
  options: ResolveAssetLinkOptions = {},
): Promise<ReferencePlanAsset> {
  const resolution = await resolveAssetLink(record, manifest, ghl, options);
  return {
    characterId: record.characterId,
    identityVersion: record.identityVersion,
    ghlFileId: resolution.link.ghlFileId,
    ghlUrl: resolution.link.ghlUrl,
    sha256: resolution.link.sha256,
    resolvedFrom: resolution.source,
    localCachePath: resolution.localCachePath,
  };
}

/**
 * Narrow a resolution to just the verbatim triplet for provider-call payloads.
 */
export function verbatimTriplet(
  resolution: AssetLinkResolution,
): CanonicalAssetLink {
  return resolution.link;
}