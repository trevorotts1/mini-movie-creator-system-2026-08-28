import type { SqliteDatabase } from "@mmcs/database/connection/index.js";

import { roundSeconds } from "./count-words.js";
import {
  RuntimeEstimatorError,
  type RuntimeEstimate,
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
 *
 * Scene rows are anchored to their summary row by `summary_id` (the summary
 * row's rowid) — never by `estimated_at`, which is millisecond-precision
 * and can collide when two estimates are computed within the same
 * millisecond. Anchoring guarantees `latest()` returns exactly one batch.
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
  summary_id INTEGER REFERENCES runtime_estimate_screenplays(id),
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

/** Strict shape check for an estimate handed to `save` (numbers finite + non-negative). */
function isPersistableEstimate(value: RuntimeEstimate): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const validNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (
    typeof value.screenplayId !== "string" ||
    value.screenplayId.trim() === "" ||
    typeof value.screenplayTitle !== "string" ||
    typeof value.estimatorVersion !== "string" ||
    value.estimatorVersion.trim() === "" ||
    typeof value.estimatedAt !== "string" ||
    value.estimatedAt.trim() === "" ||
    !validNumber(value.totalSeconds) ||
    !Number.isInteger(value.inputVersion) ||
    value.inputVersion <= 0 ||
    value.options === null ||
    typeof value.options !== "object" ||
    // Every resolved option is a finite non-negative number; a NaN/undefined
    // option would serialize to `null` in options_json and poison reloads.
    !validNumber(value.options.dialogueWordsPerSecond) ||
    !validNumber(value.options.actionWordsPerSecond) ||
    !validNumber(value.options.sceneOverheadSeconds) ||
    !validNumber(value.options.minSceneSeconds) ||
    !Array.isArray(value.perScene)
  ) {
    return false;
  }
  for (const scene of value.perScene) {
    if (
      scene === null ||
      typeof scene !== "object" ||
      typeof scene.sceneId !== "string" ||
      scene.sceneId.trim() === "" ||
      typeof scene.sceneTitle !== "string" ||
      !Number.isInteger(scene.sceneIndex) ||
      !validNumber(scene.dialogueWords) ||
      !validNumber(scene.actionWords) ||
      !validNumber(scene.dialogueSeconds) ||
      !validNumber(scene.actionSeconds) ||
      !validNumber(scene.overheadSeconds) ||
      !validNumber(scene.estimatedSeconds)
    ) {
      return false;
    }
  }
  // Persistence must never contradict itself: the summary total must equal
  // the sum of the per-scene estimates it stores beside.
  const sum = roundSeconds(value.perScene.reduce((acc, s) => acc + s.estimatedSeconds, 0));
  if (value.perScene.length === 0) {
    return value.totalSeconds === 0;
  }
  return Math.abs(sum - roundSeconds(value.totalSeconds)) <= 0.01;
}

export class RuntimeEstimateStore {
  readonly name = "runtime-estimates";

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(CREATE_TABLES_SQL);
    this.ensureSummaryAnchor();
  }

  /**
   * Add the `summary_id` anchor column to pre-existing tables (created by an
   * earlier build of this task before the anchor existed). Nullable so legacy
   * rows stay untouched; they are simply never returned by `latest()`.
   */
  private ensureSummaryAnchor(): void {
    const columns = this.db.all("PRAGMA table_info(runtime_estimate_scenes)");
    const hasAnchor = columns.some((row) => String(row["name"]) === "summary_id");
    if (!hasAnchor) {
      this.db.exec(
        "ALTER TABLE runtime_estimate_scenes ADD COLUMN summary_id INTEGER REFERENCES runtime_estimate_screenplays(id)",
      );
    }
  }

  /**
   * Persist a full estimate atomically: one summary row + one row per scene.
   * Returns the number of scene rows written.
   */
  save(estimate: RuntimeEstimate): number {
    if (!isPersistableEstimate(estimate)) {
      throw new RuntimeEstimatorError("refusing to persist a malformed estimate");
    }
    return this.db.transaction(() => {
      const summary = this.db
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
      const summaryId = summary.lastInsertRowid;

      for (const scene of estimate.perScene) {
        this.db
          .prepare(
            `INSERT INTO runtime_estimate_scenes
               (summary_id, screenplay_id, scene_index, scene_id, scene_title, dialogue_words,
                action_words, dialogue_seconds, action_seconds, overhead_seconds, estimated_seconds,
                total_seconds, estimator_version, estimated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            summaryId,
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

  /** Latest estimate for a screenplay (by insertion order of the summary row). */
  latest(screenplayId: string): PersistedRuntimeEstimate | undefined {
    const summary = this.db.get(
      `SELECT id, screenplay_id, screenplay_title, total_seconds, estimator_version, estimated_at
       FROM runtime_estimate_screenplays
       WHERE screenplay_id = ?
       ORDER BY id DESC LIMIT 1`,
      screenplayId,
    );
    if (summary === undefined) {
      return undefined;
    }
    const summaryId = Number(summary["id"]);

    const scenes = this.db
      .all(
        `SELECT scene_index, scene_id, scene_title, dialogue_words, action_words,
                dialogue_seconds, action_seconds, overhead_seconds, estimated_seconds
         FROM runtime_estimate_scenes
         WHERE summary_id = ?
         ORDER BY scene_index`,
        summaryId,
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
    // Checked unconditionally: an empty scene list with a non-zero total is
    // exactly the kind of corruption this guard exists to catch.
    const sum = roundSeconds(latest.scenes.reduce((acc, s) => acc + s.estimatedSeconds, 0));
    if (Math.abs(sum - latest.totalSeconds) > 0.01) {
      throw new RuntimeEstimatorError(
        `persisted estimate inconsistent: scene sum ${sum} != total ${latest.totalSeconds}`,
      );
    }
    return latest.totalSeconds;
  }
}
