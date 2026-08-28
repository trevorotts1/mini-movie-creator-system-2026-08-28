import type { CreateEpisodeInput, Episode, EpisodeStatus, UpdateEpisodePatch } from "./types.js";
import type { SqliteDatabase } from "../../connection/index.js";
import { SchemaRepository, ValidationError, newId } from "../projects/schema-repository.js";

const STATUSES: readonly EpisodeStatus[] = [
  "draft",
  "scripted",
  "storyboarded",
  "generated",
  "rough_cut",
  "final",
  "archived",
];
const TITLE_MAX = 512;
const SEASON_MAX = 999;
const EPISODE_MAX = 9999;
const RUNTIME_MAX = 12 * 60 * 60;

export class SqliteEpisodeRepository extends SchemaRepository {
  readonly name = "episodes";

  constructor(db: SqliteDatabase) {
    super(db);
  }

  create(input: CreateEpisodeInput): Episode {
    const title = this.requireText("title", input.title, TITLE_MAX);
    const seasonNumber = this.requireInt("seasonNumber", input.seasonNumber, 1, SEASON_MAX);
    const episodeNumber = this.requireInt("episodeNumber", input.episodeNumber, 1, EPISODE_MAX);
    const status = input.status ?? "draft";
    if (!STATUSES.includes(status)) {
      throw new ValidationError("status", `must be one of ${STATUSES.join(", ")}`);
    }
    const aspectRatioOverride =
      input.aspectRatioOverride === undefined || input.aspectRatioOverride === null
        ? null
        : this.requireAspectRatio("aspectRatioOverride", input.aspectRatioOverride, "16:9");
    const targetRuntimeSeconds =
      input.targetRuntimeSeconds === undefined || input.targetRuntimeSeconds === null
        ? null
        : this.requireInt("targetRuntimeSeconds", input.targetRuntimeSeconds, 1, RUNTIME_MAX);
    if (typeof input.projectId !== "string" || input.projectId.length === 0) {
      throw new ValidationError("projectId", "must be a non-empty string");
    }
    if (typeof input.seriesId !== "string" || input.seriesId.length === 0) {
      throw new ValidationError("seriesId", "must be a non-empty string");
    }
    // The denormalized project_id must agree with the series' own project
    // (spec §25 hierarchy): a valid-but-different project id would pass the
    // FK checks and silently corrupt listByProject and the GHL folder tree.
    const seriesRow = this.db.get("SELECT project_id FROM series WHERE id = ?", input.seriesId);
    if (seriesRow === undefined) {
      throw new ValidationError("seriesId", `series "${input.seriesId}" does not exist`);
    }
    const seriesProjectId = String(seriesRow["project_id"]);
    if (input.projectId !== seriesProjectId) {
      throw new ValidationError("projectId", `must match the series' project ("${seriesProjectId}")`);
    }
    const code = formatEpisodeCode(seasonNumber, episodeNumber);
    const now = new Date().toISOString();
    const episode: Episode = {
      id: newId("ep"),
      projectId: input.projectId,
      seriesId: input.seriesId,
      seasonNumber,
      episodeNumber,
      code,
      title,
      status,
      aspectRatioOverride,
      targetRuntimeSeconds,
      ghlFolderId: input.ghlFolderId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO episodes (
           id, project_id, series_id, season_number, episode_number, code, title, status,
           aspect_ratio_override, target_runtime_seconds, ghl_folder_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.projectId,
        episode.seriesId,
        episode.seasonNumber,
        episode.episodeNumber,
        episode.code,
        episode.title,
        episode.status,
        episode.aspectRatioOverride,
        episode.targetRuntimeSeconds,
        episode.ghlFolderId,
        episode.createdAt,
        episode.updatedAt,
      );
    return episode;
  }

  findById(id: string): Episode | undefined {
    return this.mapRow<Episode, Episode>(this.db.get("SELECT * FROM episodes WHERE id = ?", id), mapEpisodeRow);
  }

  update(id: string, patch: UpdateEpisodePatch): Episode | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    const title = patch.title !== undefined ? this.requireText("title", patch.title, TITLE_MAX) : existing.title;
    const status = patch.status ?? existing.status;
    if (!STATUSES.includes(status)) {
      throw new ValidationError("status", `must be one of ${STATUSES.join(", ")}`);
    }
    const aspectRatioOverride =
      patch.aspectRatioOverride === undefined
        ? existing.aspectRatioOverride
        : patch.aspectRatioOverride === null
          ? null
          : this.requireAspectRatio("aspectRatioOverride", patch.aspectRatioOverride, existing.aspectRatioOverride ?? "16:9");
    const targetRuntimeSeconds =
      patch.targetRuntimeSeconds === undefined
        ? existing.targetRuntimeSeconds
        : patch.targetRuntimeSeconds === null
          ? null
          : this.requireInt("targetRuntimeSeconds", patch.targetRuntimeSeconds, 1, RUNTIME_MAX);
    const ghlFolderId = patch.ghlFolderId !== undefined ? patch.ghlFolderId : existing.ghlFolderId;
    this.db
      .prepare(
        `UPDATE episodes
         SET title = ?, status = ?, aspect_ratio_override = ?, target_runtime_seconds = ?, ghl_folder_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, status, aspectRatioOverride, targetRuntimeSeconds, ghlFolderId, new Date().toISOString(), id);
    return this.findById(id);
  }

  setAspectRatioOverride(id: string, override: string | null): Episode | undefined {
    return this.update(id, { aspectRatioOverride: override });
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id).changes) > 0;
  }

  list(): Episode[] {
    return this.db
      .all("SELECT * FROM episodes ORDER BY season_number, episode_number, id")
      .map(mapEpisodeRow);
  }

  listBySeries(seriesId: string, seasonNumber?: number): Episode[] {
    const rows =
      seasonNumber === undefined
        ? this.db.all(
            "SELECT * FROM episodes WHERE series_id = ? ORDER BY season_number, episode_number, id",
            seriesId,
          )
        : this.db.all(
            "SELECT * FROM episodes WHERE series_id = ? AND season_number = ? ORDER BY episode_number, id",
            seriesId,
            seasonNumber,
          );
    return rows.map(mapEpisodeRow);
  }

  listByProject(projectId: string): Episode[] {
    return this.db
      .all("SELECT * FROM episodes WHERE project_id = ? ORDER BY season_number, episode_number, id", projectId)
      .map(mapEpisodeRow);
  }

  effectiveAspectRatio(episodeId: string): string | undefined {
    const episode = this.findById(episodeId);
    if (episode === undefined) {
      return undefined;
    }
    if (episode.aspectRatioOverride !== null) {
      return episode.aspectRatioOverride;
    }
    const series = this.db.get("SELECT aspect_ratio FROM series WHERE id = ?", episode.seriesId);
    return series === undefined ? undefined : String(series["aspect_ratio"]);
  }
}

/** Deterministic episode code, e.g. season 1 episode 3 → "S01E03". */
export function formatEpisodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

function mapEpisodeRow(row: Record<string, unknown>): Episode {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    seriesId: String(row["series_id"]),
    seasonNumber: Number(row["season_number"]),
    episodeNumber: Number(row["episode_number"]),
    code: String(row["code"]),
    title: String(row["title"]),
    status: row["status"] as EpisodeStatus,
    aspectRatioOverride: row["aspect_ratio_override"] === null ? null : String(row["aspect_ratio_override"]),
    targetRuntimeSeconds: row["target_runtime_seconds"] === null ? null : Number(row["target_runtime_seconds"]),
    ghlFolderId: row["ghl_folder_id"] === null ? null : String(row["ghl_folder_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}