import type { SqlValue } from "../../connection/index.js";
import { BaseRepository, type CrudRepository } from "../base.js";

/**
 * Shot reference assets (spec §7/§8): the ReferenceBudgetPlanner scores
 * every candidate reference by identity / wardrobe / location / prop /
 * pose-composition / start-state / end-state value and attaches only the
 * MINIMUM SUFFICIENT set to a shot. One row per candidate; `selected` +
 * `selectedRank` record the budget decision.
 */

export const REFERENCE_KINDS = [
  "IDENTITY",
  "WARDROBE",
  "LOCATION",
  "PROP",
  "SCENE_MASTER",
  "START_KEYFRAME",
  "END_KEYFRAME",
  "POSE_COMPOSITION",
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** The seven §8 scoring axes, column order matches the table. */
export const REFERENCE_SCORE_AXES = [
  "identity_value",
  "wardrobe_value",
  "location_value",
  "prop_value",
  "pose_value",
  "start_state_value",
  "end_state_value",
] as const;

export type ReferenceScores = Partial<Record<(typeof REFERENCE_SCORE_AXES)[number], number>>;

export interface ShotReference {
  readonly referenceId: string;
  readonly shotId: string;
  /** Asset manifest id (band 040 owns `assets`; soft reference). */
  readonly assetId?: string;
  readonly referenceKind: ReferenceKind;
  readonly identityValue?: number;
  readonly wardrobeValue?: number;
  readonly locationValue?: number;
  readonly propValue?: number;
  readonly poseValue?: number;
  readonly startStateValue?: number;
  readonly endStateValue?: number;
  /** Whether the budget planner attached this reference to the shot. */
  readonly selected: boolean;
  /** Attachment order within the shot's selected set (1-based). */
  readonly selectedRank?: number;
  readonly notes?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ShotReferencePatch = Partial<
  Pick<
    ShotReference,
    | "assetId"
    | "referenceKind"
    | "identityValue"
    | "wardrobeValue"
    | "locationValue"
    | "propValue"
    | "poseValue"
    | "startStateValue"
    | "endStateValue"
    | "selected"
    | "selectedRank"
    | "notes"
  >
>;

export type ShotReferenceInput = Omit<ShotReference, "createdAt" | "updatedAt"> & {
  readonly createdAt?: string;
};

const REFERENCE_COLUMNS = [
  "reference_id",
  "shot_id",
  "asset_id",
  "reference_kind",
  "identity_value",
  "wardrobe_value",
  "location_value",
  "prop_value",
  "pose_value",
  "start_state_value",
  "end_state_value",
  "selected",
  "selected_rank",
  "notes",
  "created_at",
  "updated_at",
] as const;

function mapReferenceRow(row: Record<string, SqlValue>): ShotReference {
  return {
    referenceId: String(row["reference_id"]),
    shotId: String(row["shot_id"]),
    assetId: row["asset_id"] === null ? undefined : String(row["asset_id"]),
    referenceKind: String(row["reference_kind"]) as ReferenceKind,
    identityValue: row["identity_value"] === null ? undefined : Number(row["identity_value"]),
    wardrobeValue: row["wardrobe_value"] === null ? undefined : Number(row["wardrobe_value"]),
    locationValue: row["location_value"] === null ? undefined : Number(row["location_value"]),
    propValue: row["prop_value"] === null ? undefined : Number(row["prop_value"]),
    poseValue: row["pose_value"] === null ? undefined : Number(row["pose_value"]),
    startStateValue: row["start_state_value"] === null ? undefined : Number(row["start_state_value"]),
    endStateValue: row["end_state_value"] === null ? undefined : Number(row["end_state_value"]),
    selected: Number(row["selected"]) === 1,
    selectedRank: row["selected_rank"] === null ? undefined : Number(row["selected_rank"]),
    notes: row["notes"] === null ? undefined : String(row["notes"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class ShotReferenceRepository extends BaseRepository
  implements CrudRepository<string, ShotReference, ShotReferencePatch> {
  readonly name = "shot-references";

  create(entity: ShotReferenceInput): ShotReference {
    const now = new Date().toISOString();
    if (!REFERENCE_KINDS.includes(entity.referenceKind)) {
      throw new Error(`unknown reference kind "${String(entity.referenceKind)}"`);
    }
    if (entity.selectedRank !== undefined && !Number.isInteger(entity.selectedRank)) {
      throw new Error(`selectedRank must be an integer, got ${String(entity.selectedRank)}`);
    }
    this.db
      .prepare(
        `INSERT INTO shot_references (
           reference_id, shot_id, asset_id, reference_kind,
           identity_value, wardrobe_value, location_value, prop_value,
           pose_value, start_state_value, end_state_value,
           selected, selected_rank, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.referenceId,
        entity.shotId,
        entity.assetId ?? null,
        entity.referenceKind,
        entity.identityValue ?? null,
        entity.wardrobeValue ?? null,
        entity.locationValue ?? null,
        entity.propValue ?? null,
        entity.poseValue ?? null,
        entity.startStateValue ?? null,
        entity.endStateValue ?? null,
        entity.selected ? 1 : 0,
        entity.selectedRank ?? null,
        entity.notes ?? null,
        entity.createdAt ?? now,
        now,
      );
    return this.findById(entity.referenceId) as ShotReference;
  }

  findById(id: string): ShotReference | undefined {
    return this.mapRow<Record<string, SqlValue>, ShotReference>(
      this.db.get(`SELECT ${REFERENCE_COLUMNS.join(", ")} FROM shot_references WHERE reference_id = ?`, id),
      mapReferenceRow,
    );
  }

  /** All candidates for one shot, selected first then by rank (§8 budget decision order). */
  listByShot(shotId: string): ShotReference[] {
    return this.db
      .all(
        `SELECT ${REFERENCE_COLUMNS.join(", ")} FROM shot_references
         WHERE shot_id = ? ORDER BY selected DESC, selected_rank, created_at, reference_id`,
        shotId,
      )
      .map(mapReferenceRow);
  }

  /** Selected references only, in attachment order — the §8 minimum-sufficient set. */
  listSelectedByShot(shotId: string): ShotReference[] {
    return this.db
      .all(
        `SELECT ${REFERENCE_COLUMNS.join(", ")} FROM shot_references
         WHERE shot_id = ? AND selected = 1 ORDER BY selected_rank, created_at, reference_id`,
        shotId,
      )
      .map(mapReferenceRow);
  }

  update(id: string, patch: ShotReferencePatch): ShotReference | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    if (patch.referenceKind !== undefined && !REFERENCE_KINDS.includes(patch.referenceKind)) {
      throw new Error(`unknown reference kind "${String(patch.referenceKind)}"`);
    }
    if (patch.selectedRank !== undefined && !Number.isInteger(patch.selectedRank)) {
      throw new Error(`selectedRank must be an integer, got ${String(patch.selectedRank)}`);
    }
    const next = { ...existing, ...patch } as ShotReference;
    this.db
      .prepare(
        `UPDATE shot_references SET
           asset_id = ?, reference_kind = ?,
           identity_value = ?, wardrobe_value = ?, location_value = ?, prop_value = ?,
           pose_value = ?, start_state_value = ?, end_state_value = ?,
           selected = ?, selected_rank = ?, notes = ?, updated_at = ?
         WHERE reference_id = ?`,
      )
      .run(
        next.assetId ?? null,
        next.referenceKind,
        next.identityValue ?? null,
        next.wardrobeValue ?? null,
        next.locationValue ?? null,
        next.propValue ?? null,
        next.poseValue ?? null,
        next.startStateValue ?? null,
        next.endStateValue ?? null,
        next.selected ? 1 : 0,
        next.selectedRank ?? null,
        next.notes ?? null,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM shot_references WHERE reference_id = ?").run(id).changes) > 0;
  }

  list(): ShotReference[] {
    return this.db
      .all(`SELECT ${REFERENCE_COLUMNS.join(", ")} FROM shot_references ORDER BY created_at, reference_id`)
      .map(mapReferenceRow);
  }
}