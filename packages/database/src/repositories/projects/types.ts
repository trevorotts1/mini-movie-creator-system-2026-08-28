/**
 * Project/series/episode domain records and CRUD repository contracts
 * (spec §25, §23). Domain types carry no SQL shapes; the repositories map
 * at the edge.
 */
import type { BaseRepository, CrudRepository } from "../base.js";
import type { ProjectSchemaMigration } from "../../migrations/010-project-series-episode/index.js";

/** A series or a standalone movie container (spec §25 projects). */
export type ProjectKind = "series" | "standalone";

/** Lifecycle of a project row. */
export type ProjectStatus = "active" | "archived";

/**
 * Episode pipeline position. Mirrors the approval-gate states in spec §8/§24
 * loosely — gates themselves live in `@mmcs/core` approvals; the episode row
 * only records which stage the work has reached.
 */
export type EpisodeStatus =
  | "draft"
  | "scripted"
  | "storyboarded"
  | "generated"
  | "rough_cut"
  | "final"
  | "archived";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  /** Master output format (spec §23), e.g. "16:9". */
  readonly aspectRatio: string;
  /** GHL Media Storage folder (spec §17), when provisioned. */
  readonly ghlFolderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Series {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Master format captured once at series creation (spec §23). */
  readonly aspectRatio: string;
  readonly ghlFolderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Episode {
  readonly id: string;
  readonly projectId: string;
  readonly seriesId: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  /** Deterministic code, e.g. "S01E03" (spec §19 naming). */
  readonly code: string;
  readonly title: string;
  readonly status: EpisodeStatus;
  /** Per-episode override (spec §23). `null` = inherit the series format. */
  readonly aspectRatioOverride: string | null;
  readonly targetRuntimeSeconds: number | null;
  readonly ghlFolderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly kind?: ProjectKind;
  readonly status?: ProjectStatus;
  /** Default "16:9" (spec §23 recommended default). */
  readonly aspectRatio?: string;
  readonly ghlFolderId?: string | null;
}

export interface UpdateProjectPatch {
  readonly name?: string;
  readonly status?: ProjectStatus;
  readonly aspectRatio?: string;
  readonly ghlFolderId?: string | null;
}

export interface CreateSeriesInput {
  readonly projectId: string;
  readonly name: string;
  readonly aspectRatio?: string;
  readonly ghlFolderId?: string | null;
}

export interface UpdateSeriesPatch {
  readonly name?: string;
  readonly aspectRatio?: string;
  readonly ghlFolderId?: string | null;
}

export interface CreateEpisodeInput {
  readonly projectId: string;
  readonly seriesId: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly title: string;
  readonly status?: EpisodeStatus;
  /** Override only; omit/undefined stores NULL = inherit (spec §23). */
  readonly aspectRatioOverride?: string | null;
  readonly targetRuntimeSeconds?: number | null;
  readonly ghlFolderId?: string | null;
}

export interface UpdateEpisodePatch {
  readonly title?: string;
  readonly status?: EpisodeStatus;
  /** `null` clears the override back to series inheritance. */
  readonly aspectRatioOverride?: string | null;
  readonly targetRuntimeSeconds?: number | null;
  readonly ghlFolderId?: string | null;
}

export interface ProjectRepository
  extends BaseRepository,
    CrudRepository<string, Project, UpdateProjectPatch> {
  create(input: CreateProjectInput): Project;
  /** Update the project's master aspect ratio (spec §23 "editable later"). */
  setAspectRatio(id: string, aspectRatio: string): Project | undefined;
}

export interface SeriesRepository
  extends BaseRepository,
    CrudRepository<string, Series, UpdateSeriesPatch> {
  create(input: CreateSeriesInput): Series;
  listByProject(projectId: string): Series[];
  setAspectRatio(id: string, aspectRatio: string): Series | undefined;
}

export interface EpisodeRepository
  extends BaseRepository,
    CrudRepository<string, Episode, UpdateEpisodePatch> {
  create(input: CreateEpisodeInput): Episode;
  listBySeries(seriesId: string, seasonNumber?: number): Episode[];
  listByProject(projectId: string): Episode[];
  setAspectRatioOverride(id: string, override: string | null): Episode | undefined;
  /**
   * Effective output format for an episode: the per-episode override when
   * set, otherwise the series master (spec §23).
   */
  effectiveAspectRatio(episodeId: string): string | undefined;
}

export { projectSchemaMigrations } from "../../migrations/010-project-series-episode/index.js";
export type { ProjectSchemaMigration } from "../../migrations/010-project-series-episode/index.js";