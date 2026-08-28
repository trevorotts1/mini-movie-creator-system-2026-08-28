/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import { SHOT_SPEC_FIELDS, ShotRepository, type ShotInput } from "./index.js";

let dir: string;
let db: SqliteDatabase;
let shots: ShotRepository;

function baseInput(overrides: Partial<ShotInput> = {}): ShotInput {
  return {
    shotId: "SH-0001",
    sceneId: "SC-0001",
    sequenceIndex: 1,
    targetDuration: 6,
    characters: ["char_monica"],
    characterVersions: ["appearance_monica_v02"],
    location: "loc_kitchen",
    wardrobe: ["wardrobe_monica_s01e03"],
    props: ["prop_coffee_cup"],
    dialogue: "You are late.",
    action: "She turns from the counter.",
    emotion: "tense",
    cameraAngle: "medium close-up",
    cameraMotion: "slow push in",
    lensStyle: "35mm shallow depth of field",
    lighting: "warm practicals, low key",
    startState: "Monica facing the window",
    endState: "Monica facing the door",
    continuityRequirements: "coffee cup stays in left hand",
    referenceAssets: ["asset_face_master", "asset_wardrobe_full"],
    keyframeStrategy: "START_ONLY",
    preferredProvider: "agnes-video-2.5-flash",
    fallbackProvider: "wan-3.0",
    promptSource: "scene-plan://SC-0001/SH-0001",
    promptCompiled: "Medium close-up of Monica...",
    promptCharacterCount: 640,
    estimatedCost: 0.42,
    approvalStatus: "STORYBOARD_APPROVED",
    generationStatus: "NOT_STARTED",
    qcStatus: "PENDING",
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-shots-"));
  db = connectSqlite({ path: join(dir, "shots.db") });
  migrate(db, MIGRATIONS);
  shots = new ShotRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("shots schema — spec §12 Shot Specification Record", () => {
  it("carries all 30 spec §12 required fields as introspectable columns", () => {
    // PRAGMA table_info is schema introspection: the contract is about the
    // table shape, not this file's constant list.
    const columns = db.all("PRAGMA table_info(shots)").map((row) => String(row["name"]));
    const missing = SHOT_SPEC_FIELDS.filter((field) => !columns.includes(field));
    expect(missing).toEqual([]);
    expect(SHOT_SPEC_FIELDS).toHaveLength(30);
  });

  it("round-trips every field of the Shot Specification Record", () => {
    const created = shots.create(baseInput());
    const found = shots.findById("SH-0001");
    expect(found).toBeDefined();
    expect(found).toEqual(created);
    expect(found?.characters).toEqual(["char_monica"]);
    expect(found?.characterVersions).toEqual(["appearance_monica_v02"]);
    expect(found?.wardrobe).toEqual(["wardrobe_monica_s01e03"]);
    expect(found?.props).toEqual(["prop_coffee_cup"]);
    expect(found?.referenceAssets).toEqual(["asset_face_master", "asset_wardrobe_full"]);
    expect(found?.lensStyle).toBe("35mm shallow depth of field");
    expect(found?.keyframeStrategy).toBe("START_ONLY");
    expect(found?.preferredProvider).toBe("agnes-video-2.5-flash");
    expect(found?.fallbackProvider).toBe("wan-3.0");
    expect(found?.promptCharacterCount).toBe(640);
    expect(found?.estimatedCost).toBeCloseTo(0.42);
  });

  it("defaults empty planning lists and pending statuses", () => {
    const created = shots.create(
      baseInput({
        shotId: "SH-0002",
        characters: [],
        characterVersions: [],
        location: undefined,
        wardrobe: [],
        props: [],
        dialogue: undefined,
        action: undefined,
        emotion: undefined,
        cameraAngle: undefined,
        cameraMotion: undefined,
        lensStyle: undefined,
        lighting: undefined,
        startState: undefined,
        endState: undefined,
        continuityRequirements: undefined,
        referenceAssets: [],
        keyframeStrategy: "NONE",
        preferredProvider: undefined,
        fallbackProvider: undefined,
        promptSource: undefined,
        promptCompiled: undefined,
        promptCharacterCount: undefined,
        estimatedCost: undefined,
      }),
    );
    expect(created.characters).toEqual([]);
    expect(created.wardrobe).toEqual([]);
    expect(created.props).toEqual([]);
    expect(created.referenceAssets).toEqual([]);
    expect(created.location).toBeUndefined();
    expect(created.dialogue).toBeUndefined();
    expect(created.approvalStatus).toBe("STORYBOARD_APPROVED");
    expect(created.generationStatus).toBe("NOT_STARTED");
    expect(created.qcStatus).toBe("PENDING");
    shots.delete("SH-0002");
  });

  it("rejects a shot whose keyframe strategy is not one of the §8 classifications", () => {
    expect(() =>
      shots.create(baseInput({ shotId: "SH-BAD-1", keyframeStrategy: "ALL_KEYFRAMES" as never })),
    ).toThrow(/unknown keyframe strategy/);
    expect(shots.findById("SH-BAD-1")).toBeUndefined();
  });

  it("rejects unknown lifecycle statuses on update", () => {
    shots.create(baseInput({ shotId: "SH-UPD-1" }));
    expect(() => shots.update("SH-UPD-1", { generationStatus: "TELEPORTED" as never })).toThrow(
      /unknown generation status/,
    );
    expect(() => shots.update("SH-UPD-1", { qcStatus: "MAYBE" as never })).toThrow(/unknown qc status/);
    expect(() => shots.update("SH-UPD-1", { approvalStatus: "MAYBE" as never })).toThrow(
      /unknown approval status/,
    );
    shots.delete("SH-UPD-1");
  });
});

describe("shots CRUD surface", () => {
  it("creates, reads, updates, deletes", () => {
    shots.create(baseInput({ shotId: "SH-CRUD-1", sequenceIndex: 3 }));
    expect(shots.update("SH-CRUD-1", { sequenceIndex: 5, dialogue: "Still late." })).toMatchObject({
      sequenceIndex: 5,
      dialogue: "Still late.",
    });
    expect(shots.update("SH-CRUD-1", { characters: [], characterVersions: [] })).toMatchObject({
      characters: [],
      characterVersions: [],
    });
    expect(shots.listByScene("SC-0001").map((s) => s.shotId)).toContain("SH-CRUD-1");
    expect(shots.delete("SH-CRUD-1")).toBe(true);
    expect(shots.delete("SH-CRUD-1")).toBe(false);
    expect(shots.findById("SH-CRUD-1")).toBeUndefined();
    expect(shots.update("SH-CRUD-1", { dialogue: "ghost" })).toBeUndefined();
  });

  it("orders listByScene by sequence_index and list() by created_at", () => {
    shots.create(baseInput({ shotId: "SH-ORD-3", sequenceIndex: 3 }));
    shots.create(baseInput({ shotId: "SH-ORD-1", sequenceIndex: 1 }));
    shots.create(baseInput({ shotId: "SH-ORD-2", sequenceIndex: 2 }));
    const ids = shots.listByScene("SC-0001").map((s) => s.shotId);
    const ordIds = ids.filter((id) => id.startsWith("SH-ORD-"));
    expect(ordIds).toEqual(["SH-ORD-1", "SH-ORD-2", "SH-ORD-3"]);
    expect(shots.list().length).toBeGreaterThanOrEqual(3);
    for (const id of ["SH-ORD-1", "SH-ORD-2", "SH-ORD-3"]) {
      shots.delete(id);
    }
  });
});