import type { SqliteDatabase } from "../../../database/src/connection/index.js";

import { roundSeconds } from "./count-words.js";
import {
  RuntimeEstimatorError,
  type RuntimeEstimate,
  type RuntimeEstimatorOptions,
} from "./types.js";

/**
 * Durable persistence for runtime estimates (spec §25 — durable application
 * state; DIR-005 acceptance: per-scene and total estimates persisted).
 *
 * Owns its own tables (created idempotently) so the estimator never edits
 * another task's schema. One row per (screenplay_id, scene_id) keeps the
 * per-scene estimates; the total lives with each scene row and in the
 * screenplays summary row. Re-estimating a screenplay supersedes prior rows
 * (keep-latest by inserted sequence, versioned by estimator version).
 */

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS runtime_estimate_screenplays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screenplay_id TEXT NOT NULL,
  screenplay_title TEXT NOT NULL,
  total_seconds REAL NOT NULL,
  estimator_version TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  options_json TEXT NOT NULL,
  estimated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_estimate_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screenplay_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  scene_id TEXT NOT NULL,
  scene_title TEXT NOT NULL,
  dialogue_words INTEGER NOT NULL,
  action_words INTEGER NOT NULL,
  dialogue_seconds REAL NOT NULL,
  action_seconds REAL NOT NULL,
  overhead_seconds REAL NOT NULL,
  estimated_seconds REAL NOT NULL,
  total_seconds REAL NOT NULL,
  estimator_version TEXT NOT NULL,
  estimated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_estimate_scenes_screenplay
  ON runtime_estimate_scenes (screenplay_id, scene_index);
CREATE INDEX IF NOT EXISTS idx_runtime_estimate_screenplays_screenplay
  ON runtime_estimate_screenplays (screenplay_id, estimated_at);
`;

/** Latest persisted estimate for one screenplay, or undefined. */
export interface PersistedRuntimeEstimate {
  readonly screenplayId: string;
  readonly screenplayTitle: string;
  readonly totalSeconds: number;
  readonly estimatorVersion: string;
  readonly estimatedAt: string;
  readonly scenes: Array<{
    readonly sceneIndex: number;
    readonly sceneId: string;
    readonly sceneTitle: string;
    readonly dialogueWords: number;
    readonly actionWords: number;
    readonly dialogueSeconds: number;
    readonly actionSeconds: number;
    readonly overheadSeconds: number;
    readonly estimatedSeconds: number;
  }>;
}

export class RuntimeEstimateStore {
  readonly name = "runtime-estimates";

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(CREATE_TABLES_SQL);
  }

  /**
   * Persist a full estimate atomically: one summary row + one row per scene.
   * Returns the number of scene rows written.
   */
  save(estimate: RuntimeEstimate): number {
    if (!estimate.screenplayId || estimate.perScene.length === 0 && estimate.totalSeconds !== 0) {
      throw new RuntimeEstimatorError("refusing to persist a malformed estimate");
    }
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runtime_estimate_screenplays
             (screenplay_id, screenplay_title, total_seconds, estimator_version, input_version,
              options_json, estimated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          estimate.screenplayId,
          estimate.screenplayTitle,
          estimate.totalSeconds,
          estimate.estimatorVersion,
          estimate.inputVersion,
          JSON.stringify(estimate.options),
          estimate.estimatedAt,
        );

      for (const scene of estimate.perScene) {
        this.db
          .prepare(
            `INSERT INTO runtime_estimate_scenes
               (screenplay_id, scene_index, scene_id, scene_title, dialogue_words, action_words,
                dialogue_seconds, action_seconds, overhead_seconds, estimated_seconds,
                total_seconds, estimator_version, estimated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            estimate.screenplayId,
            scene.sceneIndex,
            scene.sceneId,
            scene.sceneTitle,
            scene.dialogueWords,
            scene.actionWords,
            scene.dialogueSeconds,
            scene.actionSeconds,
            scene.overheadSeconds,
            scene.estimatedSeconds,
            estimate.totalSeconds,
            estimate.estimatorVersion,
            estimate.estimatedAt,
          );
      }
      return estimate.perScene.length;
    });
  }

  /** Latest estimate for a screenplay (by estimated_at, then insertion order). */
  latest(screenplayId: string): PersistedRuntimeEstimate | undefined {
    const summary = this.db.get(
      `SELECT screenplay_id, screenplay_title, total_seconds, estimator_version, estimated_at
       FROM runtime_estimate_screenplays
       WHERE screenplay_id = ?
       ORDER BY id DESC LIMIT 1`,
      screenplayId,
    );
    if (summary === undefined) {
      return undefined;
    }

    const scenes = this.db
      .all(
        `SELECT scene_index, scene_id, scene_title, dialogue_words, action_words,
                dialogue_seconds, action_seconds, overhead_seconds, estimated_seconds
         FROM runtime_estimate_scenes
         WHERE screenplay_id = ? AND estimator_version = ? AND estimated_at = ?
         ORDER BY scene_index`,
        String(summary["screenplay_id"]),
        String(summary["estimator_version"]),
        String(summary["estimated_at"]),
      )
      .map((row) => ({
        sceneIndex: Number(row["scene_index"]),
        sceneId: String(row["scene_id"]),
        sceneTitle: String(row["scene_title"]),
        dialogueWords: Number(row["dialogue_words"]),
        actionWords: Number(row["action_words"]),
        dialogueSeconds: roundSeconds(Number(row["dialogue_seconds"])),
        actionSeconds: roundSeconds(Number(row["action_seconds"])),
        overheadSeconds: roundSeconds(Number(row["overhead_seconds"])),
        estimatedSeconds: roundSeconds(Number(row["estimated_seconds"])),
      }));

    return {
      screenplayId: String(summary["screenplay_id"]),
      screenplayTitle: String(summary["screenplay_title"]),
      totalSeconds: roundSeconds(Number(summary["total_seconds"])),
      estimatorVersion: String(summary["estimator_version"]),
      estimatedAt: String(summary["estimated_at"]),
      scenes,
    };
  }

  /** All persisted per-scene rows for a screenplay, latest estimate first batch. */
  sceneRows(screenplayId: string): PersistedRuntimeEstimate["scenes"] {
    const latestEstimate = this.latest(screenplayId);
    if (latestEstimate === undefined) {
      return [];
    }
    // Scenes already come back in the latest batch from `latest`.
    return latestEstimate.scenes;
  }

  /** Sum of persisted per-scene estimates for the latest estimate of a screenplay. */
  persistedTotalSeconds(screenplayId: string): number | undefined {
    const latest = this.latest(screenplayId);
    if (latest === undefined) {
      return undefined;
    }
    // Recompute from the persisted scene rows and require agreement with the
    // persisted summary total — persistence must never contradict itself.
    const sum = roundSeconds(latest.scenes.reduce((acc, s) => acc + s.estimatedSeconds, 0));
    if (latest.scenes.length > 0 && Math.abs(sum - latest.totalSeconds) > 0.01) {
      throw new RuntimeEstimatorError(
        `persisted estimate inconsistent: scene sum ${sum} != total ${latest.totalSeconds}`,
      );
    }
    return latest.totalSeconds;
  }
}