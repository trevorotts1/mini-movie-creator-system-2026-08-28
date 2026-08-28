import type { SqlValue } from "../../connection/index.js";
import { BaseRepository, type CrudRepository } from "../base.js";
import {
  APPROVAL_STATUSES,
  GENERATION_STATUSES,
  KEYFRAME_STRATEGIES,
  QC_STATUSES,
  type ApprovalStatus,
  type GenerationStatus,
  type KeyframeStrategy,
  type QcStatus,
} from "./shot-statuses.js";

export {
  APPROVAL_STATUSES,
  GENERATION_STATUSES,
  KEYFRAME_STRATEGIES,
  QC_STATUSES,
  type ApprovalStatus,
  type GenerationStatus,
  type KeyframeStrategy,
  type QcStatus,
} from "./shot-statuses.js";

/**
 * The Shot Specification Record (spec §12) as a domain type.
 *
 * Every field below is REQUIRED by spec §12 — the schema-introspection
 * test in this directory asserts the `shots` table carries all of them.
 * List/structured fields (`characters`, `wardrobe`, `props`, …) travel as
 * JSON strings in SQLite; the repository serializes/deserializes at the
 * edge so domain types carry plain values (PostgreSQL `jsonb` later, §25).
 */
export interface Shot {
  readonly shotId: string;
  readonly sceneId: string;
  readonly sequenceIndex: number;
  readonly targetDuration: number;
  /** Canonical Character Library IDs planned in this shot. */
  readonly characters: string[];
  /** Active identity/hair/wardrobe version ids per character (spec §7). */
  readonly characterVersions: string[];
  /** Recurring location master id (spec §7). */
  readonly location?: string;
  readonly wardrobe: string[];
  readonly props: string[];
  readonly dialogue?: string;
  readonly action?: string;
  readonly emotion?: string;
  readonly cameraAngle?: string;
  readonly cameraMotion?: string;
  /** Spec §12 writes this `lens/style`; the column is `lens_style`. */
  readonly lensStyle?: string;
  readonly lighting?: string;
  readonly startState?: string;
  readonly endState?: string;
  readonly continuityRequirements?: string;
  /** Planned/attached reference asset ids (spec §8 budget). */
  readonly referenceAssets: string[];
  readonly keyframeStrategy: KeyframeStrategy;
  readonly preferredProvider?: string;
  readonly fallbackProvider?: string;
  readonly promptSource?: string;
  readonly promptCompiled?: string;
  readonly promptCharacterCount?: number;
  readonly estimatedCost?: number;
  readonly approvalStatus: ApprovalStatus;
  readonly generationStatus: GenerationStatus;
  readonly qcStatus: QcStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ShotPatch = Partial<
  Pick<
    Shot,
    | "sequenceIndex"
    | "targetDuration"
    | "characters"
    | "characterVersions"
    | "location"
    | "wardrobe"
    | "props"
    | "dialogue"
    | "action"
    | "emotion"
    | "cameraAngle"
    | "cameraMotion"
    | "lensStyle"
    | "lighting"
    | "startState"
    | "endState"
    | "continuityRequirements"
    | "referenceAssets"
    | "keyframeStrategy"
    | "preferredProvider"
    | "fallbackProvider"
    | "promptSource"
    | "promptCompiled"
    | "promptCharacterCount"
    | "estimatedCost"
    | "approvalStatus"
    | "generationStatus"
    | "qcStatus"
  >
>;

/** Input for creating a shot: caller supplies identity/planning fields, defaults cover statuses. */
export type ShotInput = Omit<Shot, "createdAt" | "updatedAt"> & {
  readonly createdAt?: string;
};

/** The 30 spec §12 required fields, in spec order — introspection test asserts these exist as columns. */
export const SHOT_SPEC_FIELDS = [
  "shot_id",
  "scene_id",
  "sequence_index",
  "target_duration",
  "characters",
  "character_versions",
  "location",
  "wardrobe",
  "props",
  "dialogue",
  "action",
  "emotion",
  "camera_angle",
  "camera_motion",
  "lens_style",
  "lighting",
  "start_state",
  "end_state",
  "continuity_requirements",
  "reference_assets",
  "keyframe_strategy",
  "preferred_provider",
  "fallback_provider",
  "prompt_source",
  "prompt_compiled",
  "prompt_character_count",
  "estimated_cost",
  "approval_status",
  "generation_status",
  "qc_status",
] as const;

const SHOT_COLUMNS = [...SHOT_SPEC_FIELDS, "created_at", "updated_at"] as const;

function parseJsonArray(value: SqlValue | undefined, field: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`shots.${field}: expected a JSON array of strings, got ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function mapShotRow(row: Record<string, SqlValue>): Shot {
  return {
    shotId: String(row["shot_id"]),
    sceneId: String(row["scene_id"]),
    sequenceIndex: Number(row["sequence_index"]),
    targetDuration: Number(row["target_duration"]),
    characters: parseJsonArray(row["characters"], "characters"),
    characterVersions: parseJsonArray(row["character_versions"], "character_versions"),
    location: row["location"] === null ? undefined : String(row["location"]),
    wardrobe: parseJsonArray(row["wardrobe"], "wardrobe"),
    props: parseJsonArray(row["props"], "props"),
    dialogue: row["dialogue"] === null ? undefined : String(row["dialogue"]),
    action: row["action"] === null ? undefined : String(row["action"]),
    emotion: row["emotion"] === null ? undefined : String(row["emotion"]),
    cameraAngle: row["camera_angle"] === null ? undefined : String(row["camera_angle"]),
    cameraMotion: row["camera_motion"] === null ? undefined : String(row["camera_motion"]),
    lensStyle: row["lens_style"] === null ? undefined : String(row["lens_style"]),
    lighting: row["lighting"] === null ? undefined : String(row["lighting"]),
    startState: row["start_state"] === null ? undefined : String(row["start_state"]),
    endState: row["end_state"] === null ? undefined : String(row["end_state"]),
    continuityRequirements:
      row["continuity_requirements"] === null ? undefined : String(row["continuity_requirements"]),
    referenceAssets: parseJsonArray(row["reference_assets"], "reference_assets"),
    keyframeStrategy: String(row["keyframe_strategy"]) as KeyframeStrategy,
    preferredProvider: row["preferred_provider"] === null ? undefined : String(row["preferred_provider"]),
    fallbackProvider: row["fallback_provider"] === null ? undefined : String(row["fallback_provider"]),
    promptSource: row["prompt_source"] === null ? undefined : String(row["prompt_source"]),
    promptCompiled: row["prompt_compiled"] === null ? undefined : String(row["prompt_compiled"]),
    promptCharacterCount:
      row["prompt_character_count"] === null ? undefined : Number(row["prompt_character_count"]),
    estimatedCost: row["estimated_cost"] === null ? undefined : Number(row["estimated_cost"]),
    approvalStatus: String(row["approval_status"]) as ApprovalStatus,
    generationStatus: String(row["generation_status"]) as GenerationStatus,
    qcStatus: String(row["qc_status"]) as QcStatus,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

/**
 * Durable shot record (spec §12). Provider-independent: request-shaped
 * payloads for a concrete provider are compiled from this record, never
 * stored in place of it.
 */
export class ShotRepository extends BaseRepository implements CrudRepository<string, Shot, ShotPatch> {
  readonly name = "shots";

  create(entity: ShotInput): Shot {
    const now = new Date().toISOString();
    if (!KEYFRAME_STRATEGIES.includes(entity.keyframeStrategy)) {
      throw new Error(`unknown keyframe strategy "${String(entity.keyframeStrategy)}"`);
    }
    if (!APPROVAL_STATUSES.includes(entity.approvalStatus)) {
      throw new Error(`unknown approval status "${String(entity.approvalStatus)}"`);
    }
    if (!GENERATION_STATUSES.includes(entity.generationStatus)) {
      throw new Error(`unknown generation status "${String(entity.generationStatus)}"`);
    }
    if (!QC_STATUSES.includes(entity.qcStatus)) {
      throw new Error(`unknown qc status "${String(entity.qcStatus)}"`);
    }
    this.db
      .prepare(
        `INSERT INTO shots (
           shot_id, scene_id, sequence_index, target_duration,
           characters, character_versions, location, wardrobe, props,
           dialogue, action, emotion, camera_angle, camera_motion, lens_style,
           lighting, start_state, end_state, continuity_requirements,
           reference_assets, keyframe_strategy, preferred_provider, fallback_provider,
           prompt_source, prompt_compiled, prompt_character_count, estimated_cost,
           approval_status, generation_status, qc_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.shotId,
        entity.sceneId,
        entity.sequenceIndex,
        entity.targetDuration,
        JSON.stringify(entity.characters),
        JSON.stringify(entity.characterVersions),
        entity.location ?? null,
        JSON.stringify(entity.wardrobe),
        JSON.stringify(entity.props),
        entity.dialogue ?? null,
        entity.action ?? null,
        entity.emotion ?? null,
        entity.cameraAngle ?? null,
        entity.cameraMotion ?? null,
        entity.lensStyle ?? null,
        entity.lighting ?? null,
        entity.startState ?? null,
        entity.endState ?? null,
        entity.continuityRequirements ?? null,
        JSON.stringify(entity.referenceAssets),
        entity.keyframeStrategy,
        entity.preferredProvider ?? null,
        entity.fallbackProvider ?? null,
        entity.promptSource ?? null,
        entity.promptCompiled ?? null,
        entity.promptCharacterCount ?? null,
        entity.estimatedCost ?? null,
        entity.approvalStatus,
        entity.generationStatus,
        entity.qcStatus,
        entity.createdAt ?? now,
        now,
      );
    return this.findById(entity.shotId) as Shot;
  }

  findById(id: string): Shot | undefined {
    return this.mapRow<Record<string, SqlValue>, Shot>(
      this.db.get(`SELECT ${SHOT_COLUMNS.join(", ")} FROM shots WHERE shot_id = ?`, id),
      mapShotRow,
    );
  }

  /** Shots of one scene ordered by planning sequence (spec §7). */
  listByScene(sceneId: string): Shot[] {
    return this.db
      .all(
        `SELECT ${SHOT_COLUMNS.join(", ")} FROM shots WHERE scene_id = ? ORDER BY sequence_index, shot_id`,
        sceneId,
      )
      .map(mapShotRow);
  }

  update(id: string, patch: ShotPatch): Shot | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    if (patch.keyframeStrategy !== undefined && !KEYFRAME_STRATEGIES.includes(patch.keyframeStrategy)) {
      throw new Error(`unknown keyframe strategy "${String(patch.keyframeStrategy)}"`);
    }
    if (patch.approvalStatus !== undefined && !APPROVAL_STATUSES.includes(patch.approvalStatus)) {
      throw new Error(`unknown approval status "${String(patch.approvalStatus)}"`);
    }
    if (patch.generationStatus !== undefined && !GENERATION_STATUSES.includes(patch.generationStatus)) {
      throw new Error(`unknown generation status "${String(patch.generationStatus)}"`);
    }
    if (patch.qcStatus !== undefined && !QC_STATUSES.includes(patch.qcStatus)) {
      throw new Error(`unknown qc status "${String(patch.qcStatus)}"`);
    }

    const next = { ...existing, ...patch } as Shot;
    this.db
      .prepare(
        `UPDATE shots SET
           sequence_index = ?, target_duration = ?,
           characters = ?, character_versions = ?, location = ?, wardrobe = ?, props = ?,
           dialogue = ?, action = ?, emotion = ?, camera_angle = ?, camera_motion = ?, lens_style = ?,
           lighting = ?, start_state = ?, end_state = ?, continuity_requirements = ?,
           reference_assets = ?, keyframe_strategy = ?, preferred_provider = ?, fallback_provider = ?,
           prompt_source = ?, prompt_compiled = ?, prompt_character_count = ?, estimated_cost = ?,
           approval_status = ?, generation_status = ?, qc_status = ?, updated_at = ?
         WHERE shot_id = ?`,
      )
      .run(
        next.sequenceIndex,
        next.targetDuration,
        JSON.stringify(next.characters),
        JSON.stringify(next.characterVersions),
        next.location ?? null,
        JSON.stringify(next.wardrobe),
        JSON.stringify(next.props),
        next.dialogue ?? null,
        next.action ?? null,
        next.emotion ?? null,
        next.cameraAngle ?? null,
        next.cameraMotion ?? null,
        next.lensStyle ?? null,
        next.lighting ?? null,
        next.startState ?? null,
        next.endState ?? null,
        next.continuityRequirements ?? null,
        JSON.stringify(next.referenceAssets),
        next.keyframeStrategy,
        next.preferredProvider ?? null,
        next.fallbackProvider ?? null,
        next.promptSource ?? null,
        next.promptCompiled ?? null,
        next.promptCharacterCount ?? null,
        next.estimatedCost ?? null,
        next.approvalStatus,
        next.generationStatus,
        next.qcStatus,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM shots WHERE shot_id = ?").run(id).changes) > 0;
  }

  list(): Shot[] {
    return this.db
      .all(`SELECT ${SHOT_COLUMNS.join(", ")} FROM shots ORDER BY created_at, shot_id`)
      .map(mapShotRow);
  }
}