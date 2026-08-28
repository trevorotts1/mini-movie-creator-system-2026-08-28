/**
 * Recurring location library — schema + validation (spec §11; task CHAR-011).
 *
 * A recurring location is a canonical master with an immutable version history.
 * Each version carries approved reference assets for every camera angle
 * (wide / medium / reverse) in every lighting state (day / night). Versions
 * take effect from an episode continuity point ({ season, episode }) so
 * historical episodes always resolve the canon-at-the-time version — same
 * immutable-history rule the character library applies to identity versions.
 *
 * Asset states follow the shared library lifecycle (spec §9):
 * DRAFT → REVIEW → APPROVED → CANONICAL → RETIRED (plus REJECTED).
 * Only APPROVED/CANONICAL assets auto-reuse in downstream reference plans.
 *
 * Pure data + validation; no I/O, no dependencies. Storage is an
 * implementation detail — the database adapter (CORE-005 band) wraps this
 * shape later.
 */

/** Camera angles every recurring location master must cover. */
export const LOCATION_ANGLES = ["wide", "medium", "reverse"] as const;

export type LocationAngle = (typeof LOCATION_ANGLES)[number];

/** Lighting states every recurring location master must cover. */
export const DAY_NIGHT_STATES = ["day", "night"] as const;

export type DayNightState = (typeof DAY_NIGHT_STATES)[number];

/** Shared asset lifecycle (spec §9) applied to location reference assets. */
export const ASSET_STATES = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
  "REJECTED",
] as const;

export type AssetState = (typeof ASSET_STATES)[number];

/**
 * Allowed asset state transitions. REJECTED and RETIRED are terminal —
 * rejected candidates are never reused later (spec §9).
 */
export const ASSET_TRANSITIONS: Record<AssetState, readonly AssetState[]> = {
  DRAFT: ["REVIEW", "REJECTED"],
  REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["CANONICAL", "RETIRED"],
  CANONICAL: ["RETIRED"],
  RETIRED: [],
  REJECTED: [],
};

/**
 * Stable business ID, `LOC_<NAME>_001` style (spec §9 permanent-ID rule),
 * never display-name-keyed.
 */
export const LOCATION_ID_PATTERN = /^LOC_[A-Z0-9]+(?:_[A-Z0-9]+)*_\d{3}$/;

/** Asset IDs are stable business IDs too; shape is loose but fixed-width safe. */
export const LOCATION_ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

/** SHA-256 hex digest, lowercase or uppercase. */
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Version-level lifecycle: a version is drafted, approved as a whole, retired. */
export const LOCATION_VERSION_STATES = ["DRAFT", "APPROVED", "RETIRED"] as const;

export type LocationVersionState = (typeof LOCATION_VERSION_STATES)[number];

/** Episode continuity point — season/episode the state is canon from. */
export interface ContinuityPoint {
  season: number;
  episode: number;
}

/** Durable media linkage for an approved location asset (spec §9 canonical record). */
export interface LocationMedia {
  ghlFileId: string;
  ghlUrl: string;
  sha256: string;
}

/** One approved (or in-progress) reference asset for an angle × lighting state. */
export interface LocationAngleAsset {
  assetId: string;
  angle: LocationAngle;
  dayNight: DayNightState;
  state: AssetState;
  /** Required before the asset may reach APPROVED. */
  media: LocationMedia | null;
  notes: string | null;
}

/** One immutable version of a location master. Never overwritten in place. */
export interface LocationMasterVersion {
  versionId: string;
  versionNumber: number;
  /** Continuity point this version is canon from (inclusive). */
  effectiveFrom: ContinuityPoint;
  state: LocationVersionState;
  description: string | null;
  assets: LocationAngleAsset[];
}

/** A recurring location master: stable ID + append-only version history. */
export interface LocationMaster {
  locationId: string;
  displayName: string;
  description: string | null;
  createdAt: string;
  versions: LocationMasterVersion[];
}

/** Error codes thrown by the location library. */
export type LocationErrorCode =
  | "INVALID_ID"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "MEDIA_REQUIRED"
  | "MASTER_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "DUPLICATE_VERSION"
  | "DUPLICATE_ANGLE_STATE"
  | "MISSING_ANGLE"
  | "ASSET_NOT_APPROVED"
  | "VERSION_NOT_APPROVED"
  | "NO_ACTIVE_VERSION";

/** Typed error so callers can branch on codes instead of message strings. */
export class LocationLibraryError extends Error {
  readonly code: LocationErrorCode;

  constructor(code: LocationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "LocationLibraryError";
    this.code = code;
  }
}

export function isContinuityPoint(value: unknown): value is ContinuityPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as ContinuityPoint).season) &&
    (value as ContinuityPoint).season >= 1 &&
    Number.isInteger((value as ContinuityPoint).episode) &&
    (value as ContinuityPoint).episode >= 1
  );
}

/** -1 when a is before b, 0 when equal, +1 when a is after b. */
export function compareContinuityPoints(
  a: ContinuityPoint,
  b: ContinuityPoint,
): -1 | 0 | 1 {
  if (a.season !== b.season) return a.season < b.season ? -1 : 1;
  if (a.episode !== b.episode) return a.episode < b.episode ? -1 : 1;
  return 0;
}

/** Inclusive "is this point at or after the effective-from point". */
export function isAtOrAfter(
  point: ContinuityPoint,
  effectiveFrom: ContinuityPoint,
): boolean {
  return compareContinuityPoints(point, effectiveFrom) >= 0;
}

export function isLocationAngle(value: unknown): value is LocationAngle {
  return (
    typeof value === "string" &&
    (LOCATION_ANGLES as readonly string[]).includes(value)
  );
}

export function isDayNightState(value: unknown): value is DayNightState {
  return (
    typeof value === "string" &&
    (DAY_NIGHT_STATES as readonly string[]).includes(value)
  );
}

export function isAssetState(value: unknown): value is AssetState {
  return (
    typeof value === "string" && (ASSET_STATES as readonly string[]).includes(value)
  );
}

export function isValidLocationId(value: unknown): value is string {
  return typeof value === "string" && LOCATION_ID_PATTERN.test(value);
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return /^https?:\/\/\S+$/.test(value);
}

export function assertValidLocationId(value: unknown): string {
  if (!isValidLocationId(value)) {
    throw new LocationLibraryError(
      "INVALID_ID",
      `locationId must match ${String(LOCATION_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertValidAssetId(value: unknown): string {
  if (typeof value !== "string" || !LOCATION_ASSET_ID_PATTERN.test(value)) {
    throw new LocationLibraryError(
      "INVALID_ID",
      `assetId must match ${String(LOCATION_ASSET_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function assertOptionalString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `${field} must be a string or null`,
    );
  }
  return value;
}

export interface CreateLocationMasterInput {
  locationId: string;
  displayName: string;
  description?: string | null;
  /** Defaults to { season: 1, episode: 1 } — canon from the series start. */
  effectiveFrom?: ContinuityPoint;
  createdAt?: string;
}

export function validateCreateLocationMasterInput(
  input: CreateLocationMasterInput,
): Required<Pick<LocationMaster, "locationId" | "displayName" | "description" | "createdAt">> & {
  effectiveFrom: ContinuityPoint;
} {
  assertValidLocationId(input.locationId);
  assertNonEmptyString(input.displayName, "displayName");
  if (input.effectiveFrom !== undefined && !isContinuityPoint(input.effectiveFrom)) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      "effectiveFrom must be a { season, episode } continuity point with values >= 1",
    );
  }
  const createdAt =
    input.createdAt !== undefined && input.createdAt !== null
      ? assertNonEmptyString(input.createdAt, "createdAt")
      : new Date().toISOString();
  return {
    locationId: input.locationId,
    displayName: input.displayName,
    description: assertOptionalString(input.description, "description"),
    createdAt,
    effectiveFrom: input.effectiveFrom ?? { season: 1, episode: 1 },
  };
}

export interface AddAngleAssetInput {
  assetId: string;
  angle: LocationAngle;
  dayNight: DayNightState;
  media?: LocationMedia | null;
  notes?: string | null;
}

export function validateMedia(value: unknown, field: string): LocationMedia {
  if (typeof value !== "object" || value === null) {
    throw new LocationLibraryError("INVALID_INPUT", `${field} must be an object`);
  }
  const media = value as Partial<LocationMedia>;
  if (typeof media.ghlFileId !== "string" || media.ghlFileId.length === 0) {
    throw new LocationLibraryError("INVALID_INPUT", `${field}.ghlFileId is required`);
  }
  if (!isValidHttpUrl(media.ghlUrl)) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `${field}.ghlUrl must be an http(s) URL`,
    );
  }
  if (!isValidSha256(media.sha256)) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `${field}.sha256 must be a 64-char hex SHA-256`,
    );
  }
  return {
    ghlFileId: media.ghlFileId,
    ghlUrl: media.ghlUrl,
    sha256: media.sha256,
  };
}

export function validateAddAngleAssetInput(
  input: AddAngleAssetInput,
): Required<Omit<AddAngleAssetInput, "media">> & { media: LocationMedia | null } {
  assertValidAssetId(input.assetId);
  if (!isLocationAngle(input.angle)) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `angle must be one of ${LOCATION_ANGLES.join(", ")}`,
    );
  }
  if (!isDayNightState(input.dayNight)) {
    throw new LocationLibraryError(
      "INVALID_INPUT",
      `dayNight must be one of ${DAY_NIGHT_STATES.join(", ")}`,
    );
  }
  const media =
    input.media === undefined || input.media === null
      ? null
      : validateMedia(input.media, "media");
  return {
    assetId: input.assetId,
    angle: input.angle,
    dayNight: input.dayNight,
    media,
    notes: assertOptionalString(input.notes, "notes"),
  };
}

/** Every angle × lighting combination a version needs before approval. */
export const REQUIRED_ANGLE_STATES: ReadonlyArray<{
  angle: LocationAngle;
  dayNight: DayNightState;
}> = LOCATION_ANGLES.flatMap((angle) =>
  DAY_NIGHT_STATES.map((dayNight) => ({ angle, dayNight })),
);

/** Assets usable downstream: only APPROVED/CANONICAL auto-reuse (spec §9). */
export function isAssetUsable(asset: LocationAngleAsset): boolean {
  return asset.state === "APPROVED" || asset.state === "CANONICAL";
}

/** A version may be approved only when every required combo has a usable asset. */
export function findVersionApprovalGaps(
  version: LocationMasterVersion,
): Array<{ angle: LocationAngle; dayNight: DayNightState; reason: string }> {
  const gaps: Array<{ angle: LocationAngle; dayNight: DayNightState; reason: string }> = [];
  for (const required of REQUIRED_ANGLE_STATES) {
    const asset = version.assets.find(
      (candidate) =>
        candidate.angle === required.angle && candidate.dayNight === required.dayNight,
    );
    if (!asset) {
      gaps.push({ ...required, reason: "MISSING_ANGLE" });
    } else if (!isAssetUsable(asset)) {
      gaps.push({ ...required, reason: `ASSET_${asset.state}` });
    }
  }
  return gaps;
}

export function isVersionFullyApproved(version: LocationMasterVersion): boolean {
  return version.state === "APPROVED" && findVersionApprovalGaps(version).length === 0;
}

/** Parse-and-narrow helper: throws a readable error on invalid masters. */
export function parseLocationMaster(value: unknown): LocationMaster {
  if (typeof value !== "object" || value === null) {
    throw new LocationLibraryError("INVALID_INPUT", "location master must be an object");
  }
  const master = value as Partial<LocationMaster>;
  assertValidLocationId(master.locationId);
  assertNonEmptyString(master.displayName, "displayName");
  assertNonEmptyString(master.createdAt, "createdAt");
  if (!Array.isArray(master.versions)) {
    throw new LocationLibraryError("INVALID_INPUT", "versions must be an array");
  }
  for (const version of master.versions) {
    if (typeof version !== "object" || version === null) {
      throw new LocationLibraryError("INVALID_INPUT", "version must be an object");
    }
    if (
      typeof version.versionId !== "string" ||
      version.versionId.trim().length === 0
    ) {
      throw new LocationLibraryError("INVALID_INPUT", "version versionId must be a non-empty string");
    }
    if (
      !Number.isInteger(version.versionNumber) ||
      (version.versionNumber as number) < 1
    ) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `version ${version.versionId} versionNumber must be a positive integer`,
      );
    }
    if (!isContinuityPoint(version.effectiveFrom)) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `version ${version.versionId} has an invalid effectiveFrom`,
      );
    }
    if (
      typeof version.state !== "string" ||
      !(LOCATION_VERSION_STATES as readonly string[]).includes(version.state)
    ) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `version ${version.versionId} has an invalid state`,
      );
    }
    assertOptionalString(version.description, `version ${version.versionId} description`);
    if (!Array.isArray(version.assets)) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `version ${version.versionId} assets must be an array`,
      );
    }
    const seen = new Set<string>();
    const seenAssetIds = new Set<string>();
    for (const asset of version.assets) {
      if (
        typeof asset !== "object" ||
        asset === null ||
        !isLocationAngle(asset.angle) ||
        !isDayNightState(asset.dayNight) ||
        !isAssetState(asset.state)
      ) {
        throw new LocationLibraryError(
          "INVALID_INPUT",
          `version ${version.versionId} has an invalid angle asset`,
        );
      }
      assertValidAssetId(asset.assetId);
      const combo = `${asset.angle}/${asset.dayNight}`;
      if (seen.has(combo)) {
        throw new LocationLibraryError(
          "INVALID_INPUT",
          `version ${version.versionId} has duplicate assets for ${combo}`,
        );
      }
      seen.add(combo);
      if (seenAssetIds.has(asset.assetId)) {
        throw new LocationLibraryError(
          "INVALID_INPUT",
          `version ${version.versionId} has duplicate assetId ${asset.assetId}`,
        );
      }
      seenAssetIds.add(asset.assetId);
      assertOptionalString(asset.notes, `asset ${asset.assetId} notes`);
      if (asset.media !== null && asset.media !== undefined) {
        validateMedia(asset.media, `asset ${asset.assetId} media`);
      }
    }
  }
  return value as LocationMaster;
}

/** Safe variant: returns the typed master or null when invalid. */
export function safeParseLocationMaster(value: unknown): LocationMaster | null {
  try {
    return parseLocationMaster(value);
  } catch {
    return null;
  }
}