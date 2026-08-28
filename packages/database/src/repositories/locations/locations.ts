import { BaseRepository } from "../base.js";
import type { SqlOutputValue } from "../../connection/index.js";
import {
  LOCATION_ANGLE_KINDS,
  LOCATION_TIMES_OF_DAY,
  type Location,
  type LocationAngleKind,
  type LocationAsset,
  type LocationAssetInput,
  type LocationAssetPatch,
  type LocationInput,
  type LocationPatch,
  type LocationTimeOfDay,
  type Prop,
  type PropAsset,
  type PropAssetInput,
  type PropAssetPatch,
  type PropInput,
  type PropPatch,
} from "./types.js";

/** Error thrown on illegal location/prop repository operations. */
export class LocationRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationRepositoryError";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function str(value: SqlOutputValue | undefined): string {
  return String(value);
}

function strOrNull(value: SqlOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapLocation(row: Record<string, SqlOutputValue>): Location {
  return {
    locationId: str(row["location_id"]),
    name: str(row["name"]),
    description: strOrNull(row["description"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapLocationAsset(row: Record<string, SqlOutputValue>): LocationAsset {
  return {
    assetId: str(row["asset_id"]),
    locationId: str(row["location_id"]),
    angleKind: str(row["angle_kind"]) as LocationAngleKind,
    timeOfDay: (strOrNull(row["time_of_day"]) ?? null) as LocationTimeOfDay | null,
    ghlFileId: strOrNull(row["ghl_file_id"]),
    ghlFolderId: strOrNull(row["ghl_folder_id"]),
    ghlUrl: strOrNull(row["ghl_url"]),
    sha256: strOrNull(row["sha256"]),
    provider: str(row["provider"]),
    model: str(row["model"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapProp(row: Record<string, SqlOutputValue>): Prop {
  return {
    propId: str(row["prop_id"]),
    name: str(row["name"]),
    description: strOrNull(row["description"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapPropAsset(row: Record<string, SqlOutputValue>): PropAsset {
  return {
    assetId: str(row["asset_id"]),
    propId: str(row["prop_id"]),
    ghlFileId: strOrNull(row["ghl_file_id"]),
    ghlFolderId: strOrNull(row["ghl_folder_id"]),
    ghlUrl: strOrNull(row["ghl_url"]),
    sha256: strOrNull(row["sha256"]),
    provider: str(row["provider"]),
    model: str(row["model"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

/**
 * Recurring canonical location masters (spec §19): approved
 * wide/medium/reverse angles with day/night states, each archived with
 * durable GHL linkage.
 */
export class LocationRepository extends BaseRepository {
  readonly name = "locations";

  create(input: LocationInput): Location {
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO locations (location_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.locationId, input.name, input.description ?? null, now, now);
    return this.findById(input.locationId) as Location;
  }

  findById(locationId: string): Location | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM locations WHERE location_id = ?", locationId),
      mapLocation,
    );
  }

  findByName(name: string): Location | undefined {
    return this.mapRow(this.db.get("SELECT * FROM locations WHERE name = ?", name), mapLocation);
  }

  update(locationId: string, patch: LocationPatch): Location | undefined {
    const current = this.findById(locationId);
    if (current === undefined) {
      return undefined;
    }
    const next: Location = {
      ...current,
      name: patch.name ?? current.name,
      description:
        patch.description === undefined ? current.description : patch.description,
    };
    this.db
      .prepare("UPDATE locations SET name = ?, description = ?, updated_at = ? WHERE location_id = ?")
      .run(next.name, next.description, isoNow(), locationId);
    return this.findById(locationId);
  }

  delete(locationId: string): boolean {
    return (
      Number(this.db.prepare("DELETE FROM locations WHERE location_id = ?").run(locationId).changes) > 0
    );
  }

  list(): Location[] {
    return this.db.all("SELECT * FROM locations ORDER BY name").map(mapLocation);
  }

  createAsset(input: LocationAssetInput): LocationAsset {
    if (!LOCATION_ANGLE_KINDS.includes(input.angleKind)) {
      throw new LocationRepositoryError(`invalid angle kind: ${String(input.angleKind)}`);
    }
    if (input.timeOfDay !== null && input.timeOfDay !== undefined && !LOCATION_TIMES_OF_DAY.includes(input.timeOfDay)) {
      throw new LocationRepositoryError(`invalid time of day: ${String(input.timeOfDay)}`);
    }
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO location_assets (
           asset_id, location_id, angle_kind, time_of_day, ghl_file_id,
           ghl_folder_id, ghl_url, sha256, provider, model, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId,
        input.locationId,
        input.angleKind,
        input.timeOfDay ?? null,
        input.ghlFileId ?? null,
        input.ghlFolderId ?? null,
        input.ghlUrl ?? null,
        input.sha256 ?? null,
        input.provider,
        input.model,
        now,
        now,
      );
    return this.findAssetByAssetId(input.assetId) as LocationAsset;
  }

  findAssetByAssetId(assetId: string): LocationAsset | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM location_assets WHERE asset_id = ?", assetId),
      mapLocationAsset,
    );
  }

  listAssets(locationId: string): LocationAsset[] {
    return this.db
      .all("SELECT * FROM location_assets WHERE location_id = ? ORDER BY created_at, asset_id", locationId)
      .map(mapLocationAsset);
  }

  /** Resolve an approved master by angle + optional day/night state. */
  findAsset(locationId: string, angleKind: LocationAngleKind, timeOfDay?: LocationTimeOfDay | null): LocationAsset | undefined {
    const rows = this.listAssets(locationId).filter((a) => a.angleKind === angleKind);
    if (timeOfDay !== undefined && timeOfDay !== null) {
      const exact = rows.find((a) => a.timeOfDay === timeOfDay);
      if (exact !== undefined) {
        return exact;
      }
    }
    return rows[0];
  }

  updateAsset(assetId: string, patch: LocationAssetPatch): LocationAsset | undefined {
    const current = this.findAssetByAssetId(assetId);
    if (current === undefined) {
      return undefined;
    }
    const next: LocationAsset = {
      ...current,
      ghlFileId: patch.ghlFileId === undefined ? current.ghlFileId : patch.ghlFileId,
      ghlFolderId: patch.ghlFolderId === undefined ? current.ghlFolderId : patch.ghlFolderId,
      ghlUrl: patch.ghlUrl === undefined ? current.ghlUrl : patch.ghlUrl,
      sha256: patch.sha256 === undefined ? current.sha256 : patch.sha256,
    };
    this.db
      .prepare(
        "UPDATE location_assets SET ghl_file_id = ?, ghl_folder_id = ?, ghl_url = ?, sha256 = ?, updated_at = ? WHERE asset_id = ?",
      )
      .run(next.ghlFileId, next.ghlFolderId, next.ghlUrl, next.sha256, isoNow(), assetId);
    return this.findAssetByAssetId(assetId);
  }
}

/**
 * Reusable canonical props (spec §19 "props") with durable GHL linkage.
 */
export class PropRepository extends BaseRepository {
  readonly name = "props";

  create(input: PropInput): Prop {
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO props (prop_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.propId, input.name, input.description ?? null, now, now);
    return this.findById(input.propId) as Prop;
  }

  findById(propId: string): Prop | undefined {
    return this.mapRow(this.db.get("SELECT * FROM props WHERE prop_id = ?", propId), mapProp);
  }

  findByName(name: string): Prop | undefined {
    return this.mapRow(this.db.get("SELECT * FROM props WHERE name = ?", name), mapProp);
  }

  update(propId: string, patch: PropPatch): Prop | undefined {
    const current = this.findById(propId);
    if (current === undefined) {
      return undefined;
    }
    const next: Prop = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
    };
    this.db
      .prepare("UPDATE props SET name = ?, description = ?, updated_at = ? WHERE prop_id = ?")
      .run(next.name, next.description, isoNow(), propId);
    return this.findById(propId);
  }

  delete(propId: string): boolean {
    return (
      Number(this.db.prepare("DELETE FROM props WHERE prop_id = ?").run(propId).changes) > 0
    );
  }

  list(): Prop[] {
    return this.db.all("SELECT * FROM props ORDER BY name").map(mapProp);
  }

  createAsset(input: PropAssetInput): PropAsset {
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO prop_assets (
           asset_id, prop_id, ghl_file_id, ghl_folder_id, ghl_url, sha256,
           provider, model, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId,
        input.propId,
        input.ghlFileId ?? null,
        input.ghlFolderId ?? null,
        input.ghlUrl ?? null,
        input.sha256 ?? null,
        input.provider,
        input.model,
        now,
        now,
      );
    return this.findAssetByAssetId(input.assetId) as PropAsset;
  }

  findAssetByAssetId(assetId: string): PropAsset | undefined {
    return this.mapRow(
      this.db.get("SELECT * FROM prop_assets WHERE asset_id = ?", assetId),
      mapPropAsset,
    );
  }

  listAssets(propId: string): PropAsset[] {
    return this.db
      .all("SELECT * FROM prop_assets WHERE prop_id = ? ORDER BY created_at, asset_id", propId)
      .map(mapPropAsset);
  }

  updateAsset(assetId: string, patch: PropAssetPatch): PropAsset | undefined {
    const current = this.findAssetByAssetId(assetId);
    if (current === undefined) {
      return undefined;
    }
    const next: PropAsset = {
      ...current,
      ghlFileId: patch.ghlFileId === undefined ? current.ghlFileId : patch.ghlFileId,
      ghlFolderId: patch.ghlFolderId === undefined ? current.ghlFolderId : patch.ghlFolderId,
      ghlUrl: patch.ghlUrl === undefined ? current.ghlUrl : patch.ghlUrl,
      sha256: patch.sha256 === undefined ? current.sha256 : patch.sha256,
    };
    this.db
      .prepare(
        "UPDATE prop_assets SET ghl_file_id = ?, ghl_folder_id = ?, ghl_url = ?, sha256 = ?, updated_at = ? WHERE asset_id = ?",
      )
      .run(next.ghlFileId, next.ghlFolderId, next.ghlUrl, next.sha256, isoNow(), assetId);
    return this.findAssetByAssetId(assetId);
  }
}