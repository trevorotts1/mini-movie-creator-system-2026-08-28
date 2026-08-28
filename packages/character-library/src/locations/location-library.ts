import type {
  AddAngleAssetInput,
  AssetState,
  ContinuityPoint,
  CreateLocationMasterInput,
  DayNightState,
  LocationAngle,
  LocationAngleAsset,
  LocationMaster,
  LocationMasterVersion,
} from "./location-schema.js";
import {
  ASSET_TRANSITIONS,
  LocationLibraryError,
  compareContinuityPoints,
  findVersionApprovalGaps,
  isAssetUsable,
  isDayNightState,
  isLocationAngle,
  validateAddAngleAssetInput,
  validateCreateLocationMasterInput,
  validateMedia,
} from "./location-schema.js";

/** Input for appending a new version to an existing master. */
export interface AddVersionInput {
  locationId: string;
  versionId: string;
  effectiveFrom: ContinuityPoint;
  description?: string | null;
}

/**
 * Read-only contract — mirrors what a durable repository must expose.
 * Storage-agnostic: the database adapter (CORE-005 band) can wrap this
 * contract behind a repository interface later.
 */
export interface LocationLibrary {
  createMaster(input: CreateLocationMasterInput): LocationMaster;
  getMaster(locationId: string): LocationMaster | null;
  requireMaster(locationId: string): LocationMaster;
  listMasters(): LocationMaster[];
  addVersion(input: AddVersionInput): LocationMasterVersion;
  addAngleAsset(locationId: string, versionId: string, input: AddAngleAssetInput): LocationAngleAsset;
  attachMedia(locationId: string, versionId: string, assetId: string, media: unknown): LocationAngleAsset;
  setAssetState(
    locationId: string,
    versionId: string,
    assetId: string,
    nextState: AssetState,
  ): LocationAngleAsset;
  approveVersion(locationId: string, versionId: string): LocationMasterVersion;
  retireVersion(locationId: string, versionId: string): LocationMasterVersion;
  resolveVersion(locationId: string, at: ContinuityPoint): LocationMasterVersion;
  resolveAsset(
    locationId: string,
    at: ContinuityPoint,
    angle: LocationAngle,
    dayNight: DayNightState,
  ): LocationAngleAsset;
}

/** Service implementing the library contract over a Map store. */
export class LocationLibraryService implements LocationLibrary {
  private readonly masters = new Map<string, LocationMaster>();

  /** Create a new location master with an initial DRAFT v1 version. */
  createMaster(input: CreateLocationMasterInput): LocationMaster {
    const validated = validateCreateLocationMasterInput(input);
    if (this.masters.has(validated.locationId)) {
      throw new LocationLibraryError(
        "DUPLICATE_VERSION",
        `location master ${validated.locationId} already exists`,
      );
    }
    const master: LocationMaster = {
      locationId: validated.locationId,
      displayName: validated.displayName,
      description: validated.description,
      createdAt: validated.createdAt,
      versions: [
        {
          versionId: "v1",
          versionNumber: 1,
          effectiveFrom: validated.effectiveFrom,
          state: "DRAFT",
          description: null,
          assets: [],
        },
      ],
    };
    this.masters.set(validated.locationId, master);
    return master;
  }

  getMaster(locationId: string): LocationMaster | null {
    return this.masters.get(locationId) ?? null;
  }

  requireMaster(locationId: string): LocationMaster {
    const master = this.masters.get(locationId);
    if (!master) {
      throw new LocationLibraryError(
        "MASTER_NOT_FOUND",
        `no location master ${locationId}`,
      );
    }
    return master;
  }

  listMasters(): LocationMaster[] {
    return [...this.masters.values()];
  }

  private requireVersion(locationId: string, versionId: string): LocationMasterVersion {
    const master = this.requireMaster(locationId);
    const version = master.versions.find((candidate) => candidate.versionId === versionId);
    if (!version) {
      throw new LocationLibraryError(
        "VERSION_NOT_FOUND",
        `location ${locationId} has no version ${versionId}`,
      );
    }
    return version;
  }

  /**
   * Append a new version to an existing master. Versions must move forward
   * in continuity: the new effectiveFrom must be at or after every existing
   * version's effectiveFrom, and must not collide with an existing point.
   * Prior versions stay immutable in history.
   */
  addVersion(input: AddVersionInput): LocationMasterVersion {
    const master = this.requireMaster(input.locationId);
    if (master.versions.some((candidate) => candidate.versionId === input.versionId)) {
      throw new LocationLibraryError(
        "DUPLICATE_VERSION",
        `location ${input.locationId} already has version ${input.versionId}`,
      );
    }
    if (master.versions.some((candidate) => compareContinuityPoints(candidate.effectiveFrom, input.effectiveFrom) === 0)) {
      throw new LocationLibraryError(
        "DUPLICATE_VERSION",
        `location ${input.locationId} already has a version effective at S${input.effectiveFrom.season}E${input.effectiveFrom.episode}`,
      );
    }
    const latest = master.versions.reduce((acc, candidate) =>
      compareContinuityPoints(candidate.effectiveFrom, acc.effectiveFrom) > 0 ? candidate : acc,
    );
    if (compareContinuityPoints(input.effectiveFrom, latest.effectiveFrom) < 0) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `new version effectiveFrom S${input.effectiveFrom.season}E${input.effectiveFrom.episode} is before the latest version's S${latest.effectiveFrom.season}E${latest.effectiveFrom.episode}`,
      );
    }
    const version: LocationMasterVersion = {
      versionId: input.versionId,
      versionNumber: master.versions.length + 1,
      effectiveFrom: input.effectiveFrom,
      state: "DRAFT",
      description: input.description ?? null,
      assets: [],
    };
    master.versions.push(version);
    return version;
  }

  /** Add a reference asset for one angle × lighting combo inside a version. */
  addAngleAsset(
    locationId: string,
    versionId: string,
    input: AddAngleAssetInput,
  ): LocationAngleAsset {
    const version = this.requireVersion(locationId, versionId);
    if (version.state === "APPROVED" || version.state === "RETIRED") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `version ${versionId} is ${version.state}; assets are immutable after approval`,
      );
    }
    const validated = validateAddAngleAssetInput(input);
    const duplicate = version.assets.find(
      (candidate) =>
        candidate.angle === validated.angle && candidate.dayNight === validated.dayNight,
    );
    if (duplicate) {
      throw new LocationLibraryError(
        "DUPLICATE_ANGLE_STATE",
        `version ${versionId} already has a ${validated.angle}/${validated.dayNight} asset (${duplicate.assetId})`,
      );
    }
    const asset: LocationAngleAsset = { ...validated, state: "DRAFT" };
    version.assets.push(asset);
    return asset;
  }

  /** Attach durable media linkage to a draft asset (required before approval). */
  attachMedia(
    locationId: string,
    versionId: string,
    assetId: string,
    media: unknown,
  ): LocationAngleAsset {
    const version = this.requireVersion(locationId, versionId);
    if (version.state === "APPROVED" || version.state === "RETIRED") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `version ${versionId} is ${version.state}; assets are immutable after approval`,
      );
    }
    const asset = version.assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) {
      throw new LocationLibraryError(
        "VERSION_NOT_FOUND",
        `version ${versionId} has no asset ${assetId}`,
      );
    }
    if (asset.state === "REJECTED" || asset.state === "RETIRED" || asset.state === "CANONICAL") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `asset ${assetId} is ${asset.state}; media cannot be replaced`,
      );
    }
    asset.media = validateMedia(media, "media");
    return asset;
  }

  /** Advance an asset along the shared lifecycle (spec §9 transitions). */
  setAssetState(
    locationId: string,
    versionId: string,
    assetId: string,
    nextState: AssetState,
  ): LocationAngleAsset {
    const version = this.requireVersion(locationId, versionId);
    const asset = version.assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) {
      throw new LocationLibraryError(
        "VERSION_NOT_FOUND",
        `version ${versionId} has no asset ${assetId}`,
      );
    }
    const allowed = ASSET_TRANSITIONS[asset.state];
    if (!allowed.includes(nextState)) {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `asset ${assetId} cannot move ${asset.state} → ${nextState}; allowed: ${allowed.join(", ") || "none"}`,
      );
    }
    if (
      (nextState === "APPROVED" || nextState === "CANONICAL") &&
      (asset.media === null || asset.media === undefined)
    ) {
      throw new LocationLibraryError(
        "MEDIA_REQUIRED",
        `asset ${assetId} needs media (ghlFileId/ghlUrl/sha256) before ${nextState}`,
      );
    }
    asset.state = nextState;
    return asset;
  }

  /**
   * Approve a version only when every required angle × lighting combo has a
   * usable (APPROVED or CANONICAL) asset with durable media attached.
   */
  approveVersion(locationId: string, versionId: string): LocationMasterVersion {
    const version = this.requireVersion(locationId, versionId);
    if (version.state === "APPROVED") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `version ${versionId} is already APPROVED`,
      );
    }
    if (version.state === "RETIRED") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `version ${versionId} is RETIRED and cannot be approved`,
      );
    }
    const gaps = findVersionApprovalGaps(version);
    if (gaps.length > 0) {
      const detail = gaps
        .map((gap) => `${gap.angle}/${gap.dayNight}:${gap.reason}`)
        .join(", ");
      throw new LocationLibraryError(
        "ASSET_NOT_APPROVED",
        `version ${versionId} cannot be approved — incomplete angle coverage: ${detail}`,
      );
    }
    version.state = "APPROVED";
    return version;
  }

  /** Retire a version; retired versions stop resolving for future episodes. */
  retireVersion(locationId: string, versionId: string): LocationMasterVersion {
    const version = this.requireVersion(locationId, versionId);
    if (version.state !== "APPROVED") {
      throw new LocationLibraryError(
        "INVALID_TRANSITION",
        `only APPROVED versions can retire; ${versionId} is ${version.state}`,
      );
    }
    version.state = "RETIRED";
    return version;
  }

  /**
   * Resolve the canon version for an episode continuity point: the APPROVED
   * version with the latest effectiveFrom that is still at or before the
   * requested point. Historical episodes naturally resolve older versions.
   */
  resolveVersion(locationId: string, at: ContinuityPoint): LocationMasterVersion {
    const master = this.requireMaster(locationId);
    if (!isContinuityPointInput(at)) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        "at must be a { season, episode } continuity point with values >= 1",
      );
    }
    const candidates = master.versions
      .filter((version) => version.state === "APPROVED")
      .filter((version) => compareContinuityPoints(version.effectiveFrom, at) <= 0)
      .sort((a, b) => compareContinuityPoints(b.effectiveFrom, a.effectiveFrom));
    const resolved = candidates[0];
    if (!resolved) {
      throw new LocationLibraryError(
        "NO_ACTIVE_VERSION",
        `location ${locationId} has no approved version in effect at S${at.season}E${at.episode}`,
      );
    }
    return resolved;
  }

  /**
   * Resolve the exact asset to use for a shot: canon version at the
   * continuity point, then the angle × lighting asset inside it.
   */
  resolveAsset(
    locationId: string,
    at: ContinuityPoint,
    angle: LocationAngle,
    dayNight: DayNightState,
  ): LocationAngleAsset {
    if (!isLocationAngle(angle) || !isDayNightState(dayNight)) {
      throw new LocationLibraryError(
        "INVALID_INPUT",
        `angle must be one of wide/medium/reverse and dayNight one of day/night`,
      );
    }
    const version = this.resolveVersion(locationId, at);
    const asset = version.assets.find(
      (candidate) =>
        candidate.angle === angle && candidate.dayNight === dayNight && isAssetUsable(candidate),
    );
    if (!asset) {
      throw new LocationLibraryError(
        "ASSET_NOT_APPROVED",
        `location ${locationId} version ${version.versionId} has no usable ${angle}/${dayNight} asset`,
      );
    }
    return asset;
  }
}

function isContinuityPointInput(value: unknown): value is ContinuityPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as ContinuityPoint).season) &&
    (value as ContinuityPoint).season >= 1 &&
    Number.isInteger((value as ContinuityPoint).episode) &&
    (value as ContinuityPoint).episode >= 1
  );
}

/** Factory matching surrounding packages' export style. */
export function createLocationLibrary(): LocationLibraryService {
  return new LocationLibraryService();
}