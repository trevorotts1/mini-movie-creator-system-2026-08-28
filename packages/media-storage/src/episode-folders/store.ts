/**
 * SQLite persistence for episode folder IDs (GHL-010).
 *
 * Own table `episode_folders`, created lazily (CREATE TABLE IF NOT EXISTS) so
 * the module stays additive and never mutates another task's migrations. One
 * row per MMCS episode: the episode folder's own ID plus all nine §17
 * subfolder IDs, the ensured spine IDs (root/Series/series/Season), and the
 * exact persisted folder name (override or derived).
 *
 * All writes go through upserts keyed by episode_id — re-running ensure is
 * a no-op at the persistence layer (same row updated, not duplicated), and
 * `findByEpisodeId` short-circuits the whole network path on a warm record.
 */
import type { SqliteDatabase } from "@mmcs/database";
import type { EpisodeFolderRecord } from "./types.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS episode_folders (
  episode_id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  root_folder_id TEXT NOT NULL,
  series_node_folder_id TEXT NOT NULL,
  series_folder_id TEXT NOT NULL,
  season_folder_id TEXT NOT NULL,
  episode_folder_id TEXT NOT NULL,
  episode_folder_name TEXT NOT NULL,
  script_folder_id TEXT NOT NULL,
  characters_folder_id TEXT NOT NULL,
  scene_masters_folder_id TEXT NOT NULL,
  storyboards_folder_id TEXT NOT NULL,
  audio_folder_id TEXT NOT NULL,
  video_clips_folder_id TEXT NOT NULL,
  rough_cut_folder_id TEXT NOT NULL,
  final_folder_id TEXT NOT NULL,
  qc_metadata_folder_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

const INSERT_SQL = `
INSERT INTO episode_folders (
  episode_id, series_id, location_id,
  root_folder_id, series_node_folder_id, series_folder_id, season_folder_id,
  episode_folder_id, episode_folder_name,
  script_folder_id, characters_folder_id, scene_masters_folder_id,
  storyboards_folder_id, audio_folder_id, video_clips_folder_id,
  rough_cut_folder_id, final_folder_id, qc_metadata_folder_id,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(episode_id) DO UPDATE SET
  series_id = excluded.series_id,
  location_id = excluded.location_id,
  root_folder_id = excluded.root_folder_id,
  series_node_folder_id = excluded.series_node_folder_id,
  series_folder_id = excluded.series_folder_id,
  season_folder_id = excluded.season_folder_id,
  episode_folder_id = excluded.episode_folder_id,
  episode_folder_name = excluded.episode_folder_name,
  script_folder_id = excluded.script_folder_id,
  characters_folder_id = excluded.characters_folder_id,
  scene_masters_folder_id = excluded.scene_masters_folder_id,
  storyboards_folder_id = excluded.storyboards_folder_id,
  audio_folder_id = excluded.audio_folder_id,
  video_clips_folder_id = excluded.video_clips_folder_id,
  rough_cut_folder_id = excluded.rough_cut_folder_id,
  final_folder_id = excluded.final_folder_id,
  qc_metadata_folder_id = excluded.qc_metadata_folder_id,
  updated_at = excluded.updated_at
`;

const SELECT_BY_EPISODE_SQL = `SELECT * FROM episode_folders WHERE episode_id = ?`;

export class EpisodeFolderStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(CREATE_TABLE_SQL);
  }

  /** Persist (insert-or-replace) the full ID set for one episode. */
  save(record: EpisodeFolderRecord): void {
    this.db
      .prepare(INSERT_SQL)
      .run(
        record.episodeId,
        record.seriesId,
        record.locationId,
        record.root,
        record.seriesNode,
        record.series,
        record.season,
        record.episode,
        record.episodeName,
        record.script,
        record.characters,
        record.sceneMasters,
        record.storyboards,
        record.audio,
        record.videoClips,
        record.roughCut,
        record.final,
        record.qcMetadata,
        record.createdAt,
        record.updatedAt,
      );
  }

  findByEpisodeId(episodeId: string): EpisodeFolderRecord | undefined {
    const row = this.db.get(SELECT_BY_EPISODE_SQL, episodeId);
    return row === undefined ? undefined : mapRow(row);
  }
}

/** Subfolder key → column name, kept in one place next to the DDL. */
const SUBFOLDER_COLUMNS = {
  script: "script_folder_id",
  characters: "characters_folder_id",
  sceneMasters: "scene_masters_folder_id",
  storyboards: "storyboards_folder_id",
  audio: "audio_folder_id",
  videoClips: "video_clips_folder_id",
  roughCut: "rough_cut_folder_id",
  final: "final_folder_id",
  qcMetadata: "qc_metadata_folder_id",
};

function requireText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`episode_folders row: column "${column}" missing or empty`);
  }
  return value;
}

function mapRow(row: Record<string, unknown>): EpisodeFolderRecord {
  return {
    episodeId: requireText(row, "episode_id"),
    seriesId: requireText(row, "series_id"),
    locationId: requireText(row, "location_id"),
    root: requireText(row, "root_folder_id"),
    seriesNode: requireText(row, "series_node_folder_id"),
    series: requireText(row, "series_folder_id"),
    season: requireText(row, "season_folder_id"),
    episode: requireText(row, "episode_folder_id"),
    episodeName: requireText(row, "episode_folder_name"),
    script: requireText(row, SUBFOLDER_COLUMNS.script),
    characters: requireText(row, SUBFOLDER_COLUMNS.characters),
    sceneMasters: requireText(row, SUBFOLDER_COLUMNS.sceneMasters),
    storyboards: requireText(row, SUBFOLDER_COLUMNS.storyboards),
    audio: requireText(row, SUBFOLDER_COLUMNS.audio),
    videoClips: requireText(row, SUBFOLDER_COLUMNS.videoClips),
    roughCut: requireText(row, SUBFOLDER_COLUMNS.roughCut),
    final: requireText(row, SUBFOLDER_COLUMNS.final),
    qcMetadata: requireText(row, SUBFOLDER_COLUMNS.qcMetadata),
    createdAt: requireText(row, "created_at"),
    updatedAt: requireText(row, "updated_at"),
  };
}
