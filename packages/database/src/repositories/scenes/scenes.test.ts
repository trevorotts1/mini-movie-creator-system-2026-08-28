/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import { SceneRepository, type SceneInput } from "./index.js";

let dir: string;
let db: SqliteDatabase;
let scenes: SceneRepository;

function baseInput(overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    sceneId: "SC-0001",
    episodeId: "EP-0001",
    sequenceIndex: 1,
    title: "Kitchen confrontation",
    description: "Monica and the rival meet in the kitchen",
    durationSeconds: 45,
    characterIds: ["char_monica", "char_dana"],
    locationId: "loc_kitchen",
    sceneMasterAssetId: "asset_scene_master_kitchen",
    visualSourceType: "GENERATED_VIDEO",
    planningStatus: "PLANNED",
    estimatedCostUsd: 3.5,
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-scenes-"));
  db = connectSqlite({ path: join(dir, "scenes.db") });
  migrate(db, MIGRATIONS);
  scenes = new SceneRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scenes repository", () => {
  it("round-trips a scene with defaults", () => {
    const created = scenes.create(baseInput());
    expect(created).toEqual(scenes.findById("SC-0001"));
    expect(created.characterIds).toEqual(["char_monica", "char_dana"]);
    expect(created.planningStatus).toBe("PLANNED");
    expect(created.visualSourceType).toBe("GENERATED_VIDEO");
  });

  it("creates a minimal scene with PENDING visual source", () => {
    const created = scenes.create(
      baseInput({
        sceneId: "SC-MIN-1",
        episodeId: undefined,
        title: undefined,
        description: undefined,
        durationSeconds: undefined,
        characterIds: [],
        locationId: undefined,
        sceneMasterAssetId: undefined,
        visualSourceType: "PENDING",
        estimatedCostUsd: undefined,
      }),
    );
    expect(created.characterIds).toEqual([]);
    expect(created.visualSourceType).toBe("PENDING");
    expect(created.episodeId).toBeUndefined();
  });

  it("accepts all four spec §22 visual source types plus PENDING", () => {
    // §22: 1) generated character video, 2) AI still with Remotion
    // treatment, 3) stock/B-roll, 4) native Remotion graphics — the schema
    // must be able to record all four decisions, plus PENDING pre-decision.
    const expected: SceneInput["visualSourceType"][] = [
      "GENERATED_VIDEO",
      "AI_STILL",
      "STOCK_OR_UPSCALED",
      "NATIVE_GRAPHICS",
      "PENDING",
    ];
    for (const [index, type] of expected.entries()) {
      const sceneId = `SC-VIS-${index}`;
      const created = scenes.create(baseInput({ sceneId, visualSourceType: type }));
      expect(created.visualSourceType).toBe(type);
      expect(scenes.findById(sceneId)?.visualSourceType).toBe(type);
    }
  });

  it("rejects unknown planning status and visual source type", () => {
    expect(() => scenes.create(baseInput({ sceneId: "SC-BAD-1", planningStatus: "DREAMING" as never }))).toThrow(
      /unknown planning status/,
    );
    expect(() =>
      scenes.create(baseInput({ sceneId: "SC-BAD-2", visualSourceType: "HOLOGRAM" as never })),
    ).toThrow(/unknown visual source type/);
    expect(scenes.findById("SC-BAD-1")).toBeUndefined();
  });

  it("updates scenes and rejects bad patch values", () => {
    scenes.create(baseInput({ sceneId: "SC-UPD-1" }));
    expect(scenes.update("SC-UPD-1", { planningStatus: "APPROVED", estimatedCostUsd: 4.1 })).toMatchObject({
      planningStatus: "APPROVED",
      estimatedCostUsd: 4.1,
    });
    expect(() => scenes.update("SC-UPD-1", { planningStatus: "DREAMING" as never })).toThrow(
      /unknown planning status/,
    );
    expect(scenes.update("nope", { title: "ghost" })).toBeUndefined();
  });

  it("lists by sequence order and deletes", () => {
    scenes.create(baseInput({ sceneId: "SC-ORD-2", sequenceIndex: 2 }));
    scenes.create(baseInput({ sceneId: "SC-ORD-1", sequenceIndex: 1 }));
    const ordIds = scenes.list().map((s) => s.sceneId).filter((id) => id.startsWith("SC-ORD-"));
    expect(ordIds).toEqual(["SC-ORD-1", "SC-ORD-2"]);
    expect(scenes.delete("SC-ORD-1")).toBe(true);
    expect(scenes.delete("SC-ORD-1")).toBe(false);
  });
});