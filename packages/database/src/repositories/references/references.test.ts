/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import { REFERENCE_KINDS, REFERENCE_SCORE_AXES, ShotReferenceRepository, type ShotReferenceInput } from "./index.js";

let dir: string;
let db: SqliteDatabase;
let references: ShotReferenceRepository;

function baseInput(overrides: Partial<ShotReferenceInput> = {}): ShotReferenceInput {
  return {
    referenceId: "REF-0001",
    shotId: "SH-0001",
    assetId: "asset_face_master",
    referenceKind: "IDENTITY",
    identityValue: 0.95,
    wardrobeValue: 0.4,
    locationValue: 0.1,
    propValue: 0.05,
    poseValue: 0.3,
    startStateValue: 0.6,
    endStateValue: 0.2,
    selected: true,
    selectedRank: 1,
    notes: "front-facing master",
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-refs-"));
  db = connectSqlite({ path: join(dir, "refs.db") });
  migrate(db, MIGRATIONS);
  references = new ShotReferenceRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("shot_references schema — spec §8 scoring axes", () => {
  it("carries every §8 scoring axis as an introspectable column", () => {
    const columns = db.all("PRAGMA table_info(shot_references)").map((row) => String(row["name"]));
    const missing = REFERENCE_SCORE_AXES.filter((axis) => !columns.includes(axis));
    expect(missing).toEqual([]);
  });

  it("exposes all eight reference kinds", () => {
    expect(REFERENCE_KINDS).toEqual([
      "IDENTITY",
      "WARDROBE",
      "LOCATION",
      "PROP",
      "SCENE_MASTER",
      "START_KEYFRAME",
      "END_KEYFRAME",
      "POSE_COMPOSITION",
    ]);
 expect(() => references.create(baseInput({ referenceId: "REF-BAD", referenceKind: "AURA" as never }))).toThrow(
      /unknown reference kind/,
    );
  });
});

describe("shot_references CRUD + budget ordering", () => {
  it("round-trips scores and selection", () => {
    const created = references.create(baseInput());
    expect(created).toEqual(references.findById("REF-0001"));
    expect(created.selected).toBe(true);
    expect(created.selectedRank).toBe(1);
  });

  it("orders listByShot selected-first then rank (minimum-sufficient set first)", () => {
    references.create(
      baseInput({
        referenceId: "REF-0002",
        shotId: "SH-BUDGET",
        referenceKind: "WARDROBE",
        selected: false,
        selectedRank: undefined,
        wardrobeValue: 0.9,
      }),
    );
    references.create(baseInput({ referenceId: "REF-0003", shotId: "SH-BUDGET", selectedRank: 2 }));
    const listed = references.listByShot("SH-BUDGET").map((r) => r.referenceId);
    expect(listed).toEqual(["REF-0003", "REF-0002"]);
    const selected = references.listSelectedByShot("SH-BUDGET").map((r) => r.referenceId);
    expect(selected).toEqual(["REF-0003"]);
  });

  it("updates selection and rejects bad kinds/ranks", () => {
    references.create(baseInput({ referenceId: "REF-UPD-1", selected: false }));
    expect(references.update("REF-UPD-1", { selected: true, selectedRank: 3 })).toMatchObject({
      selected: true,
      selectedRank: 3,
    });
    expect(() => references.update("REF-UPD-1", { referenceKind: "AURA" as never })).toThrow(
      /unknown reference kind/,
    );
    expect(() => references.update("REF-UPD-1", { selectedRank: 1.5 })).toThrow(/selectedRank must be an integer/);
    expect(references.update("nope", { selected: true })).toBeUndefined();
  });

  it("deletes", () => {
    references.create(baseInput({ referenceId: "REF-DEL-1" }));
    expect(references.delete("REF-DEL-1")).toBe(true);
    expect(references.delete("REF-DEL-1")).toBe(false);
    expect(references.findById("REF-DEL-1")).toBeUndefined();
  });
});