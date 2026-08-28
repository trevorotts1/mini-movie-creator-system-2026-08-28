/**
 * Domain types for the character/location/appearance repositories
 * (CORE-005, spec §9). These are the records the repositories persist and
 * return — SQL column shapes stay behind the row mappers.
 */

import type { AssetApprovalState } from "../characters/asset-states.js";

/** Lifecycle of a character record itself (spec §9, plus the LOCK gate). */
export type CharacterState = "DRAFT" | "APPROVED" | "LOCKED" | "CANONICAL" | "RETIRED";

export const CHARACTER_STATES: readonly CharacterState[] = [
  "DRAFT",
  "APPROVED",
  "LOCKED",
  "CANONICAL",
  "RETIRED",
];

/** A global Character Library character (spec §9 "Permanent IDs"). */
export interface Character {
  /** Stable business ID, `CHAR_MONICA_BENNETT_001` style; never name-keyed. */
  readonly characterId: string;
  /** Mutable display prose; the ID, not this field, is the key. */
  displayName: string;
  /** Lifecycle state; LOCKED/CANONICAL characters are the reusable cast. */
  state: CharacterState;
  /** Bound Fish Audio voice profile, when assigned. */
  voiceProfileId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link CharacterRepository.create}; timestamps defaulted. */
export interface CharacterInput {
  characterId: string;
  displayName: string;
  state?: CharacterState;
  voiceProfileId?: string | null;
}

/** Mutable fields of {@link Character}. */
export interface CharacterPatch {
  displayName?: string;
  state?: CharacterState;
  voiceProfileId?: string | null;
}

/** One immutable identity version of a character (spec §9 identity history). */
export interface IdentityVersion {
  readonly id: number;
  readonly characterId: string;
  /** Version label, `v1`, `v2`, … unique per character. */
  readonly versionLabel: string;
  description: string | null;
  readonly createdAt: string;
}

/** Input for {@link IdentityVersionRepository.create}. */
export interface IdentityVersionInput {
  characterId: string;
  versionLabel: string;
  description?: string | null;
}

/** A canonical identity asset with durable GHL linkage (spec §9 record). */
export interface IdentityAsset {
  /** MMCS asset ID (`IDENT_ASSET_…` style stable business ID). */
  readonly assetId: string;
  /** Owning immutable identity version row. */
  readonly identityVersionId: number;
  readonly characterId: string;
  /** GHL media file ID; null until archival completes. */
  ghlFileId: string | null;
  /** GHL folder ID; null until archival completes. */
  ghlFolderId: string | null;
  /** Durable GHL URL; used verbatim downstream. */
  ghlUrl: string | null;
  /** SHA-256 of the media bytes (lowercase hex) or null. */
  sha256: string | null;
  localCachePath: string | null;
  width: number;
  height: number;
  provider: string;
  model: string;
  sourceJobId: string | null;
  prompt: string;
  approvalState: AssetApprovalState;
  /** True only once the character is LOCKED and this is the master. */
  canonical: boolean;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link IdentityAssetRepository.create}. */
export interface IdentityAssetInput {
  assetId: string;
  identityVersionId: number;
  characterId: string;
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
  localCachePath?: string | null;
  width: number;
  height: number;
  provider: string;
  model: string;
  sourceJobId?: string | null;
  prompt: string;
  approvalState?: AssetApprovalState;
  canonical?: boolean;
}

/** Mutable fields of {@link IdentityAsset} (archival + lifecycle). */
export interface IdentityAssetPatch {
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
  localCachePath?: string | null;
  approvalState?: AssetApprovalState;
  canonical?: boolean;
}

/** One immutable appearance version (spec §9 appearance w/ effective point). */
export interface AppearanceVersion {
  readonly id: number;
  readonly characterId: string;
  /** Version label, `v1`, `v2`, … unique per character. */
  readonly versionLabel: string;
  /** Hair state, e.g. `long-braids-v1`. */
  readonly hairVersion: string;
  /** Wardrobe state, e.g. `business-blue-v1`. */
  readonly wardrobeVersion: string;
  /** Base identity master this appearance derives from — never replaced. */
  readonly baseIdentityVersionId: number;
  /** Episode this version becomes canon from, `S01E09` style. */
  readonly effectiveEpisode: string | null;
  /** Wall-clock instant this version becomes canon from (ISO 8601). */
  readonly effectiveTime: string | null;
  readonly changeNote: string | null;
  state: AssetApprovalState;
  readonly createdAt: string;
}

/** Input for {@link AppearanceVersionRepository.create}. */
export interface AppearanceVersionInput {
  characterId: string;
  versionLabel: string;
  hairVersion: string;
  wardrobeVersion: string;
  baseIdentityVersionId: number;
  effectiveEpisode?: string | null;
  effectiveTime?: string | null;
  changeNote?: string | null;
  state?: AssetApprovalState;
}

/** A recurring location master (spec §19 "recurring locations"). */
export interface Location {
  readonly locationId: string;
  name: string;
  description: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link LocationRepository.create}. */
export interface LocationInput {
  locationId: string;
  name: string;
  description?: string | null;
}

/** Mutable fields of {@link Location}. */
export interface LocationPatch {
  name?: string;
  description?: string | null;
}

/** Angle masters approved for a recurring location (spec §19). */
export type LocationAngleKind = "wide" | "medium" | "reverse";

export const LOCATION_ANGLE_KINDS: readonly LocationAngleKind[] = [
  "wide",
  "medium",
  "reverse",
];

/** Day/night states of a location master (spec §19). */
export type LocationTimeOfDay = "day" | "night";

export const LOCATION_TIMES_OF_DAY: readonly LocationTimeOfDay[] = ["day", "night"];

/** An approved location master image with durable GHL linkage. */
export interface LocationAsset {
  readonly assetId: string;
  readonly locationId: string;
  readonly angleKind: LocationAngleKind;
  readonly timeOfDay: LocationTimeOfDay | null;
  ghlFileId: string | null;
  ghlFolderId: string | null;
  ghlUrl: string | null;
  sha256: string | null;
  provider: string;
  model: string;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link LocationRepository.createAsset}. */
export interface LocationAssetInput {
  assetId: string;
  locationId: string;
  angleKind: LocationAngleKind;
  timeOfDay?: LocationTimeOfDay | null;
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
  provider: string;
  model: string;
}

/** Mutable fields of {@link LocationAsset} (archival linkage). */
export interface LocationAssetPatch {
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
}

/** A reusable canonical prop (spec §19 "props"). */
export interface Prop {
  readonly propId: string;
  name: string;
  description: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link PropRepository.create}. */
export interface PropInput {
  propId: string;
  name: string;
  description?: string | null;
}

/** Mutable fields of {@link Prop}. */
export interface PropPatch {
  name?: string;
  description?: string | null;
}

/** An approved prop master image with durable GHL linkage. */
export interface PropAsset {
  readonly assetId: string;
  readonly propId: string;
  ghlFileId: string | null;
  ghlFolderId: string | null;
  ghlUrl: string | null;
  sha256: string | null;
  provider: string;
  model: string;
  readonly createdAt: string;
  updatedAt: string;
}

/** Input for {@link PropRepository.createAsset}. */
export interface PropAssetInput {
  assetId: string;
  propId: string;
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
  provider: string;
  model: string;
}

/** Mutable fields of {@link PropAsset} (archival linkage). */
export interface PropAssetPatch {
  ghlFileId?: string | null;
  ghlFolderId?: string | null;
  ghlUrl?: string | null;
  sha256?: string | null;
}