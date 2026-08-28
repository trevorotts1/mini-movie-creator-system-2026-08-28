/**
 * Episode folder persistence (MMCS task GHL-010) — types + seam.
 *
 * Spec §17 episode subtree:
 *   Convert and Flow/Series/<Series Name>/Season NN/SNNEE - <Episode Title>/
 *     {01 Script, 02 Characters, 03 Scene Masters, 04 Storyboards, 05 Audio,
 *      06 Video Clips, 07 Rough Cut, 08 Final, 09 QC Metadata}
 *
 * Responsibilities split across tasks:
 *  - GHL-003 owns the concrete HTTP folder adapter (POST /medias/folder,
 *    GET /medias/files search). This module defines the client seam only —
 *    deliberately shaped like the GHL-004 `GhlFoldersClient` interface so a
 *    single concrete adapter satisfies both without glue.
 *  - GHL-010 owns: ensuring the episode subtree (search-before-create),
 *    persisting ALL returned folder IDs (episode folder + the 9 subfolders)
 *    in SQLite, honoring per-episode overrides (spec §23 pattern: the
 *    episode-level value beats the series-derived default), and idempotent
 *    re-runs (a second run over the same episode creates zero folders and
 *    returns the same IDs).
 */

/** A GHL media-storage folder reference (as returned by search/create). */
export interface GhlFolder {
  /** GHL folder ID as returned by the API. */
  id: string;
  name: string;
  /** Parent folder ID; undefined for location-root-level folders. */
  parentId?: string;
}

/** Exact-name folder search within a location, optionally under one parent. */
export interface FindFoldersQuery {
  /** Location (sub-account) context — spec §17: altType=location, altId. */
  altId: string;
  altType: "location";
  /** Exact folder name to match. Search is exact, never partial. */
  name: string;
  /** Restrict the search to children of this folder. */
  parentId?: string;
}

/** Folder-creation request (spec §17 step 2). */
export interface CreateFolderInput {
  altId: string;
  altType: "location";
  name: string;
  parentId?: string;
}

/**
 * Folder-client seam. `findFolders` is search-before-create's read half;
 * `createFolder` persists a new folder and returns its ID. Structurally
 * compatible with the GHL-004 tree seam (same call shapes).
 */
export interface EpisodeFoldersClient {
  findFolders(query: FindFoldersQuery): Promise<GhlFolder[]>;
  createFolder(input: CreateFolderInput): Promise<GhlFolder>;
}

/** Spec §17 root + spine folder names this module ensures when needed. */
export const ROOT_FOLDER_NAME = "Convert and Flow";
export const SERIES_NODE_NAME = "Series";

/** Spec §17 episode subfolders 01–09, in order. */
export const EPISODE_SUBFOLDERS = [
  "01 Script",
  "02 Characters",
  "03 Scene Masters",
  "04 Storyboards",
  "05 Audio",
  "06 Video Clips",
  "07 Rough Cut",
  "08 Final",
  "09 QC Metadata",
] as const;

/** Discriminated subfolder keys used in the persisted record. */
export const EPISODE_SUBFOLDER_KEYS = [
  "script",
  "characters",
  "sceneMasters",
  "storyboards",
  "audio",
  "videoClips",
  "roughCut",
  "final",
  "qcMetadata",
] as const;

export type EpisodeSubfolderKey = (typeof EPISODE_SUBFOLDER_KEYS)[number];

/** Zero-pad to two digits ("Season 01", "S01E01"). */
export function pad2(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new RangeError(`Season/episode number out of range: ${String(n)}`);
  }
  return String(n).padStart(2, "0");
}

/** "Season 01" — spec §17 season level. */
export function seasonFolderName(season: number): string {
  return `Season ${pad2(season)}`;
}

/** "S01E01" — matches CORE-004's episode `code` column format. */
export function episodeCode(season: number, episode: number): string {
  return `S${pad2(season)}E${pad2(episode)}`;
}

/**
 * Derived episode folder name "S01E01 - <Title>" (spec §17). The per-episode
 * `folderNameOverride` (request field) replaces this when present.
 */
export function episodeFolderName(season: number, episode: number, title: string): string {
  return `${episodeCode(season, episode)} - ${title}`;
}

/** One episode's folder-ensure request. */
export interface EpisodeFolderRequest {
  /** GHL location (sub-account) ID — altId for every call. */
  locationId: string;
  /** MMCS series row ID (persistence key alongside `episodeId`). */
  seriesId: string;
  /** MMCS episode row ID (persistence primary key). */
  episodeId: string;
  /** Series display name — the <Series Name> folder level. */
  seriesName: string;
  seasonNumber: number;
  episodeNumber: number;
  /** Episode title used in the derived "SNNEE - <Title>" folder name. */
  title: string;
  /**
   * Per-episode override (spec §23 pattern): when present it is respected
   * verbatim as the episode folder name instead of the derived
   * "SNNEE - <Title>" form.
   */
  folderNameOverride?: string;
  /**
   * Already-persisted "Convert and Flow" root folder ID (e.g. from a GHL-004
   * tree run). When omitted, the root is ensured by exact name instead.
   */
  rootFolderId?: string;
}

/** Spine IDs + the episode folder's own reference. */
export interface EpisodeFolderSpine {
  /** "Convert and Flow" root (given or ensured). */
  root: string;
  /** "Series" spine node under the root. */
  seriesNode: string;
  /** The series' own folder (its display name). */
  series: string;
  /** "Season NN" folder. */
  season: string;
  /** The episode folder itself ("SNNEE - <Title>" or the override). */
  episode: string;
  /** The episode folder's exact persisted name. */
  episodeName: string;
}

/** The full set of persisted folder IDs for one episode (spine + 9 subfolders). */
export type EpisodeFolderIds = EpisodeFolderSpine & Record<EpisodeSubfolderKey, string>;

/** Ensure outcome for one episode. */
export interface EnsureEpisodeFolderResult {
  ids: EpisodeFolderIds;
  /** Folders this run actually created. 0 on an idempotent re-run. */
  createdCount: number;
  /** True when every ID came from search/adoption or an existing record. */
  reused: boolean;
}

/** Persisted record shape (SQLite row, camelCase) — flat: spine + 9 subfolders. */
export interface EpisodeFolderRecord extends EpisodeFolderSpine {
  episodeId: string;
  seriesId: string;
  locationId: string;
  script: string;
  characters: string;
  sceneMasters: string;
  storyboards: string;
  audio: string;
  videoClips: string;
  roughCut: string;
  final: string;
  qcMetadata: string;
  createdAt: string;
  updatedAt: string;
}
