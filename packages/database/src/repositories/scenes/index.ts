import type { SqlValue } from "../../connection/index.js";
import { BaseRepository, type CrudRepository } from "../base.js";

/**
 * Narrative scene (spec §7): scenes are planned separately from generation
 * shots — a 45-second scene is typically 5–8 shots. The scene row carries
 * the planning state that survives across the whole pipeline (storyboard
 * approval gates any paid generation, spec §7).
 */

export const PLANNING_STATUSES = [
  "PLANNED",
  "STORYBOARD",
  "APPROVED",
  "GENERATING",
  "COMPLETE",
  "BLOCKED",
] as const;

export type PlanningStatus = (typeof PLANNING_STATUSES)[number];

export const VISUAL_SOURCE_TYPES = [
  "GENERATED_VIDEO",
  "AI_STILL",
  "ANIMATED_STILL",
  "STOCK_OR_UPSCALED",
  "PENDING",
] as const;

export type VisualSourceType = (typeof VISUAL_SOURCE_TYPES)[number];

export interface Scene {
  readonly sceneId: string;
  /** Episode soft reference (band 010 owns the episodes table). */
  readonly episodeId?: string;
  readonly sequenceIndex: number;
  readonly title?: string;
  readonly description?: string;
  readonly durationSeconds?: number;
  /** Canonical Character Library IDs in this scene (spec §7 planning order). */
  readonly characterIds: string[];
  /** Recurring location master id (CHAR-011 library; soft reference). */
  readonly locationId?: string;
  /** Approved scene-master image for multi-character continuity (spec §8). */
  readonly sceneMasterAssetId?: string;
  readonly visualSourceType: VisualSourceType;
  readonly planningStatus: PlanningStatus;
  readonly estimatedCostUsd?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ScenePatch = Partial<
  Pick<
    Scene,
    | "episodeId"
    | "sequenceIndex"
    | "title"
    | "description"
    | "durationSeconds"
    | "characterIds"
    | "locationId"
    | "sceneMasterAssetId"
    | "visualSourceType"
    | "planningStatus"
    | "estimatedCostUsd"
  >
>;

export type SceneInput = Omit<Scene, "createdAt" | "updatedAt"> & { readonly createdAt?: string };

const SCENE_COLUMNS = [
  "scene_id",
  "episode_id",
  "sequence_index",
  "title",
  "description",
  "duration_seconds",
  "character_ids",
  "location_id",
  "scene_master_asset_id",
  "visual_source_type",
  "planning_status",
  "estimated_cost_usd",
  "created_at",
  "updated_at",
] as const;

function parseJsonArray(value: SqlValue | undefined, field: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`scenes.${field}: expected a JSON array of strings, got ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function mapSceneRow(row: Record<string, SqlValue>): Scene {
  return {
    sceneId: String(row["scene_id"]),
    episodeId: row["episode_id"] === null ? undefined : String(row["episode_id"]),
    sequenceIndex: Number(row["sequence_index"]),
    title: row["title"] === null ? undefined : String(row["title"]),
    description: row["description"] === null ? undefined : String(row["description"]),
    durationSeconds: row["duration_seconds"] === null ? undefined : Number(row["duration_seconds"]),
    characterIds: parseJsonArray(row["character_ids"], "character_ids"),
    locationId: row["location_id"] === null ? undefined : String(row["location_id"]),
    sceneMasterAssetId:
      row["scene_master_asset_id"] === null ? undefined : String(row["scene_master_asset_id"]),
    visualSourceType: String(row["visual_source_type"] ?? "PENDING") as VisualSourceType,
    planningStatus: String(row["planning_status"]) as PlanningStatus,
    estimatedCostUsd: row["estimated_cost_usd"] === null ? undefined : Number(row["estimated_cost_usd"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class SceneRepository extends BaseRepository implements CrudRepository<string, Scene, ScenePatch> {
  readonly name = "scenes";

  create(entity: SceneInput): Scene {
    const now = new Date().toISOString();
    if (!PLANNING_STATUSES.includes(entity.planningStatus)) {
      throw new Error(`unknown planning status "${String(entity.planningStatus)}"`);
    }
    if (!VISUAL_SOURCE_TYPES.includes(entity.visualSourceType)) {
      throw new Error(`unknown visual source type "${String(entity.visualSourceType)}"`);
    }
    this.db
      .prepare(
        `INSERT INTO scenes (
           scene_id, episode_id, sequence_index, title, description, duration_seconds,
           character_ids, location_id, scene_master_asset_id, visual_source_type,
           planning_status, estimated_cost_usd, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.sceneId,
        entity.episodeId ?? null,
        entity.sequenceIndex,
        entity.title ?? null,
        entity.description ?? null,
        entity.durationSeconds ?? null,
        JSON.stringify(entity.characterIds),
        entity.locationId ?? null,
        entity.sceneMasterAssetId ?? null,
        entity.visualSourceType,
        entity.planningStatus,
        entity.estimatedCostUsd ?? null,
        entity.createdAt ?? now,
        now,
      );
    return this.findById(entity.sceneId) as Scene;
  }

  findById(id: string): Scene | undefined {
    return this.mapRow<Record<string, SqlValue>, Scene>(
      this.db.get(`SELECT ${SCENE_COLUMNS.join(", ")} FROM scenes WHERE scene_id = ?`, id),
      mapSceneRow,
    );
  }

  update(id: string, patch: ScenePatch): Scene | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    if (patch.planningStatus !== undefined && !PLANNING_STATUSES.includes(patch.planningStatus)) {
      throw new Error(`unknown planning status "${String(patch.planningStatus)}"`);
    }
    if (patch.visualSourceType !== undefined && !VISUAL_SOURCE_TYPES.includes(patch.visualSourceType)) {
      throw new Error(`unknown visual source type "${String(patch.visualSourceType)}"`);
    }
    const next = { ...existing, ...patch } as Scene;
    this.db
      .prepare(
        `UPDATE scenes SET
           episode_id = ?, sequence_index = ?, title = ?, description = ?, duration_seconds = ?,
           character_ids = ?, location_id = ?, scene_master_asset_id = ?,
           visual_source_type = ?, planning_status = ?, estimated_cost_usd = ?, updated_at = ?
         WHERE scene_id = ?`,
      )
      .run(
        next.episodeId ?? null,
        next.sequenceIndex,
        next.title ?? null,
        next.description ?? null,
        next.durationSeconds ?? null,
        JSON.stringify(next.characterIds),
        next.locationId ?? null,
        next.sceneMasterAssetId ?? null,
        next.visualSourceType,
        next.planningStatus,
        next.estimatedCostUsd ?? null,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM scenes WHERE scene_id = ?").run(id).changes) > 0;
  }

  list(): Scene[] {
    return this.db
      .all(`SELECT ${SCENE_COLUMNS.join(", ")} FROM scenes ORDER BY sequence_index, scene_id`)
      .map(mapSceneRow);
  }
}