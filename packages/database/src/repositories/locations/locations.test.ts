/// <reference types="node" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import { LocationRepository, LocationRepositoryError, PropRepository } from "./index.js";

// Asset tables RESTRICT-delete their parents, so test isolation means a
// fresh database per case — never DELETE-based cleanup.
let dir: string;
let caseCounter = 0;
let db: SqliteDatabase;
let locations: LocationRepository;
let props: PropRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-locs-"));
});

beforeEach(() => {
  caseCounter += 1;
  db = connectSqlite({ path: join(dir, `case-${caseCounter}.db`) });
  migrate(db, MIGRATIONS);
  locations = new LocationRepository(db);
  props = new PropRepository(db);
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OFFICE = "LOC_OFFICE";

describe("location masters (CORE-005, spec §19)", () => {
  it("creates and looks up locations by ID and name", () => {
    locations.create({ locationId: OFFICE, name: "Bennett & Co. office", description: "open floor" });
    expect(locations.findById(OFFICE)?.name).toBe("Bennett & Co. office");
    expect(locations.findByName("Bennett & Co. office")?.locationId).toBe(OFFICE);
  });

  it("enforces unique location names", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    expect(() => locations.create({ locationId: "LOC_OFFICE_2", name: "Office" })).toThrow();
  });

  it("updates mutable fields and refuses unknown IDs", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    expect(locations.update(OFFICE, { name: "Main office", description: "day" })?.name).toBe("Main office");
    expect(locations.update("LOC_GHOST", { name: "x" })).toBeUndefined();
  });

  it("lists locations ordered by name", () => {
    locations.create({ locationId: "LOC_B", name: "Bistro" });
    locations.create({ locationId: "LOC_A", name: "Apartment" });
    expect(locations.list().map((l) => l.locationId)).toEqual(["LOC_A", "LOC_B"]);
  });

  it("stores approved angle/day-night masters with GHL linkage", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    const wide = locations.createAsset({
      assetId: "LOC_ASSET_OFFICE_WIDE_DAY_001",
      locationId: OFFICE,
      angleKind: "wide",
      timeOfDay: "day",
      ghlFileId: "GHL_FILE_W1",
      ghlFolderId: "GHL_FOLDER_O",
      ghlUrl: "https://files.gohighlevel.com/office-wide-day.png",
      sha256: "c".repeat(64),
      provider: "agnes",
      model: "agnes-image-2.5",
    });
    expect(wide.angleKind).toBe("wide");
    expect(wide.timeOfDay).toBe("day");
    expect(wide.ghlFileId).toBe("GHL_FILE_W1");
    expect(wide.sha256).toBe("c".repeat(64));

    locations.createAsset({
      assetId: "LOC_ASSET_OFFICE_REVERSE_NIGHT_001",
      locationId: OFFICE,
      angleKind: "reverse",
      timeOfDay: "night",
      provider: "agnes",
      model: "agnes-image-2.5",
    });
    expect(locations.listAssets(OFFICE)).toHaveLength(2);

    // GHL columns exist at the schema level.
    const columns = db.all("PRAGMA table_info(location_assets)").map((r) => String(r["name"]));
    for (const column of ["ghl_file_id", "ghl_folder_id", "ghl_url", "sha256"]) {
      expect(columns).toContain(column);
    }
  });

  it("rejects an invalid angle kind and invalid time of day", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    expect(() =>
      locations.createAsset({
        assetId: "X1",
        locationId: OFFICE,
        angleKind: "aerial" as never,
        provider: "p",
        model: "m",
      }),
    ).toThrow(LocationRepositoryError);
    expect(() =>
      locations.createAsset({
        assetId: "X2",
        locationId: OFFICE,
        angleKind: "wide",
        timeOfDay: "dusk" as never,
        provider: "p",
        model: "m",
      }),
    ).toThrow(LocationRepositoryError);
  });

  it("resolves an exact angle+time master with day/night fallback", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    locations.createAsset({
      assetId: "LOC_ASSET_OFFICE_MED_DAY_001",
      locationId: OFFICE,
      angleKind: "medium",
      timeOfDay: "day",
      provider: "p",
      model: "m",
    });
    expect(locations.findAsset(OFFICE, "medium", "day")?.assetId).toBe("LOC_ASSET_OFFICE_MED_DAY_001");
    // No night medium exists: falls back to the angle's first master.
    expect(locations.findAsset(OFFICE, "medium", "night")?.assetId).toBe("LOC_ASSET_OFFICE_MED_DAY_001");
    expect(locations.findAsset(OFFICE, "reverse")).toBeUndefined();
  });

  it("updates archival linkage on a location asset", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    locations.createAsset({
      assetId: "LOC_ASSET_OFFICE_WIDE_001",
      locationId: OFFICE,
      angleKind: "wide",
      provider: "p",
      model: "m",
    });
    const updated = locations.updateAsset("LOC_ASSET_OFFICE_WIDE_001", {
      ghlFileId: "GHL_FILE_L1",
      ghlUrl: "https://files.gohighlevel.com/o.png",
      sha256: "d".repeat(64),
    });
    expect(updated?.ghlFileId).toBe("GHL_FILE_L1");
    expect(updated?.sha256).toBe("d".repeat(64));
  });

  it("refuses to delete a location that still owns masters", () => {
    locations.create({ locationId: OFFICE, name: "Office" });
    locations.createAsset({
      assetId: "LOC_ASSET_KEEP_001",
      locationId: OFFICE,
      angleKind: "wide",
      provider: "p",
      model: "m",
    });
    expect(() => locations.delete(OFFICE)).toThrow(/FOREIGN KEY/);
  });
});

describe("props (CORE-005, spec §19)", () => {
  it("creates, updates and lists props", () => {
    props.create({ propId: "PROP_LAPTOP_001", name: "Monica's laptop", description: "company laptop" });
    expect(props.findById("PROP_LAPTOP_001")?.name).toBe("Monica's laptop");
    expect(props.update("PROP_LAPTOP_001", { description: "stolen company laptop" })?.description).toBe(
      "stolen company laptop",
    );
    props.create({ propId: "PROP_URN_001", name: "Award urn" });
    // list() orders by name: "Award urn" sorts before "Monica's laptop".
    expect(props.list().map((p) => p.propId)).toEqual(["PROP_URN_001", "PROP_LAPTOP_001"]);
  });

  it("enforces unique prop names", () => {
    props.create({ propId: "PROP_A_001", name: "Key" });
    expect(() => props.create({ propId: "PROP_B_001", name: "Key" })).toThrow();
    expect(props.findByName("Key")?.propId).toBe("PROP_A_001");
  });

  it("stores prop masters with GHL linkage and updates it", () => {
    props.create({ propId: "PROP_LAPTOP_001", name: "Laptop" });
    const asset = props.createAsset({
      assetId: "PROP_ASSET_LAPTOP_001",
      propId: "PROP_LAPTOP_001",
      provider: "agnes",
      model: "agnes-image-2.5",
    });
    expect(asset.ghlFileId).toBeNull();

    const updated = props.updateAsset(asset.assetId, {
      ghlFileId: "GHL_FILE_P1",
      ghlFolderId: "GHL_FOLDER_P1",
      ghlUrl: "https://files.gohighlevel.com/laptop.png",
      sha256: "e".repeat(64),
    });
    expect(updated?.ghlFileId).toBe("GHL_FILE_P1");
    expect(updated?.ghlFolderId).toBe("GHL_FOLDER_P1");

    const columns = db.all("PRAGMA table_info(prop_assets)").map((r) => String(r["name"]));
    for (const column of ["ghl_file_id", "ghl_folder_id", "ghl_url", "sha256"]) {
      expect(columns).toContain(column);
    }
  });

  it("rejects malformed sha256 on prop assets", () => {
    props.create({ propId: "PROP_LAPTOP_001", name: "Laptop" });
    expect(() =>
      props.createAsset({
        assetId: "PROP_ASSET_BAD_001",
        propId: "PROP_LAPTOP_001",
        sha256: "zzz",
        provider: "p",
        model: "m",
      }),
    ).toThrow();
  });

  it("refuses to delete a prop that still owns masters", () => {
    props.create({ propId: "PROP_KEEP_001", name: "Kept" });
    props.createAsset({
      assetId: "PROP_ASSET_KEEP_001",
      propId: "PROP_KEEP_001",
      provider: "p",
      model: "m",
    });
    expect(() => props.delete("PROP_KEEP_001")).toThrow(/FOREIGN KEY/);
  });

  it("exposes repository names for registry wiring", () => {
    expect(locations.name).toBe("locations");
    expect(props.name).toBe("props");
  });
});