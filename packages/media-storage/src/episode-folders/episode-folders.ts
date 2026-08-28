/**
 * Episode folder ensure + persistence — spec §17 episode subtree (GHL-010).
 *
 * Path ensured (search-before-create at every level):
 *   Convert and Flow/Series/<Series Name>/Season NN/SNNEE - <Episode Title>/
 *     {01 Script … 09 QC Metadata}
 *
 * Contract:
 *  - Search before create: every level queries by exact name under its parent
 *    first; existing folders are adopted, never duplicated (spec §17 idempotency).
 *  - Persist ALL IDs: episode folder + all nine subfolder IDs go to SQLite
 *    (`episode_folders` table) alongside the spine IDs.
 *  - Per-episode override respected: `folderNameOverride` replaces the derived
 *    "SNNEE - <Title>" episode-folder name verbatim (spec §23 override pattern).
 *  - Idempotent: a persisted record short-circuits the network entirely; a
 *    record-less re-run over an already-populated GHL location adopts every
 *    folder via search and creates zero folders. The re-run tests assert both.
 *  - Per-run memo keyed by (parentId, name) so repeated levels in one run
 *    (two episodes of one series) never issue a second create.
 *
 * The concrete HTTP client (GHL-003) is injected; this module never touches
 * credentials (GHL-001 owns auth/config).
 */
import {
  EPISODE_SUBFOLDERS,
  EPISODE_SUBFOLDER_KEYS,
  ROOT_FOLDER_NAME,
  SERIES_NODE_NAME,
  episodeFolderName,
  seasonFolderName,
  type CreateFolderInput,
  type EpisodeFolderIds,
  type EpisodeFolderRecord,
  type EpisodeFolderRequest,
  type EpisodeFoldersClient,
  type EpisodeSubfolderKey,
  type EnsureEpisodeFolderResult,
  type FindFoldersQuery,
} from "./types.js";
import { EpisodeFolderStore } from "./store.js";

export interface EpisodeFolderEnsurerOptions {
  client: EpisodeFoldersClient;
  store: EpisodeFolderStore;
}

/** Validate + trim one folder name; empty/whitespace-only names are fatal. */
function requireFolderName(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
  return trimmed;
}

export class EpisodeFolderEnsurer {
  constructor(private readonly options: EpisodeFolderEnsurerOptions) {}

  /**
   * Ensure the full episode subtree for one episode and persist every ID.
   * Throws on API errors from the injected client; persistence happens only
   * after the complete chain (root → … → episode → 9 subfolders) resolved.
   */
  async ensure(request: EpisodeFolderRequest): Promise<EnsureEpisodeFolderResult> {
    const locationId = requireFolderName("locationId", request.locationId);
    const episodeId = requireFolderName("episodeId", request.episodeId);
    const seriesId = requireFolderName("seriesId", request.seriesId);
    const seriesName = requireFolderName("seriesName", request.seriesName);
    if (!Number.isInteger(request.seasonNumber) || request.seasonNumber < 1 || request.seasonNumber > 99) {
      throw new RangeError(`seasonNumber: must be an integer 1–99, got ${String(request.seasonNumber)}`);
    }
    if (!Number.isInteger(request.episodeNumber) || request.episodeNumber < 1 || request.episodeNumber > 99) {
      throw new RangeError(`episodeNumber: must be an integer 1–99, got ${String(request.episodeNumber)}`);
    }
    const title = requireFolderName("title", request.title);

    // Idempotency fast path: a persisted record IS the durable answer. The
    // record's episode folder name is authoritative (it captured the override
    // at first-ensure time); a later title change must not rewrite history.
    const existing = this.options.store.findByEpisodeId(episodeId);
    if (existing !== undefined) {
      if (existing.locationId !== locationId) {
        throw new Error(
          `episode "${episodeId}" already persisted for location "${existing.locationId}", refusing re-ensure under "${locationId}"`,
        );
      }
      return { ids: toIds(existing), createdCount: 0, reused: true };
    }

    // Per-run memo: repeated (parentId, name) levels reuse one node.
    const seen = new Map<string, string>();
    let createdCount = 0;

    const ensureFolder = async (parent: string | undefined, name: string): Promise<string> => {
      const key = `${parent ?? ""}//${name}`;
      const cached = seen.get(key);
      if (cached !== undefined) return cached;
      const query: FindFoldersQuery = {
        altId: locationId,
        altType: "location",
        name,
        ...(parent !== undefined ? { parentId: parent } : {}),
      };
      const found = (await this.options.client.findFolders(query))[0];
      let id: string;
      if (found) {
        id = found.id;
      } else {
        const input: CreateFolderInput = {
          altId: locationId,
          altType: "location",
          name,
          ...(parent !== undefined ? { parentId: parent } : {}),
        };
        const created = await this.options.client.createFolder(input);
        id = created.id;
        createdCount++;
      }
      seen.set(key, id);
      return id;
    };

    // Spine: root → Series → <Series Name> → Season NN.
    const rootId =
      request.rootFolderId !== undefined
        ? requireFolderName("rootFolderId", request.rootFolderId)
        : await ensureFolder(undefined, ROOT_FOLDER_NAME);
    const seriesNodeId = await ensureFolder(rootId, SERIES_NODE_NAME);
    const seriesFolderId = await ensureFolder(seriesNodeId, seriesName);
    const seasonFolderId = await ensureFolder(seriesFolderId, seasonFolderName(request.seasonNumber));

    // Episode folder: override verbatim, else derived "SNNEE - <Title>".
    const episodeName =
      request.folderNameOverride !== undefined
        ? requireFolderName("folderNameOverride", request.folderNameOverride)
        : episodeFolderName(request.seasonNumber, request.episodeNumber, title);
    const episodeFolderId = await ensureFolder(seasonFolderId, episodeName);

    // The nine §17 subfolders, in order.
    const subfolderIds = {} as Record<EpisodeSubfolderKey, string>;
    for (let i = 0; i < EPISODE_SUBFOLDER_KEYS.length; i++) {
      const key = EPISODE_SUBFOLDER_KEYS[i];
      const folder = EPISODE_SUBFOLDERS[i];
      if (key === undefined || folder === undefined) {
        throw new Error(`episode subfolder arrays misaligned at index ${String(i)}`);
      }
      subfolderIds[key] = await ensureFolder(episodeFolderId, folder);
    }

    const ids: EpisodeFolderIds = {
      root: rootId,
      seriesNode: seriesNodeId,
      series: seriesFolderId,
      season: seasonFolderId,
      episode: episodeFolderId,
      episodeName,
      ...subfolderIds,
    };

    const now = new Date().toISOString();
    const record: EpisodeFolderRecord = {
      episodeId,
      seriesId,
      locationId,
      ...ids,
      createdAt: now,
      updatedAt: now,
    };
    this.options.store.save(record);

    return { ids, createdCount, reused: createdCount === 0 };
  }
}

/** Narrow a flat record to the ID-set view (drop meta fields). */
function toIds(record: EpisodeFolderRecord): EpisodeFolderIds {
  return {
    root: record.root,
    seriesNode: record.seriesNode,
    series: record.series,
    season: record.season,
    episode: record.episode,
    episodeName: record.episodeName,
    script: record.script,
    characters: record.characters,
    sceneMasters: record.sceneMasters,
    storyboards: record.storyboards,
    audio: record.audio,
    videoClips: record.videoClips,
    roughCut: record.roughCut,
    final: record.final,
    qcMetadata: record.qcMetadata,
  };
}
