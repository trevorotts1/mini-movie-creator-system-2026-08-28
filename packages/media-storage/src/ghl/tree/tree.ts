/**
 * Idempotent "Convert and Flow" folder tree builder — spec §17.
 *
 * Tree:
 *   Convert and Flow/
 *     Character Library/<Character Name>/{Identity Masters, Expressions, Wardrobe,
 *       Voice References, Approved Scene References}
 *     Series/<Series Name>/Series Bible/{Characters, Locations, Wardrobe, Props}
 *     Series/<Series Name>/Season NN/SNNEE - <Episode Title>/{01 Script … 09 QC Metadata}
 *     Standalone Movies/<Project Name>/{01 Script … 09 QC Metadata}
 *
 * Idempotency: every level is searched (GET /medias/files, exact name) before it is
 * created (POST /medias/folder); existing folders are adopted, never duplicated, so
 * a second run over a populated location performs zero create calls.
 */
import type {
  CreateFolderInput,
  FindFoldersQuery,
  GhlFoldersClient,
  GhlFolder,
} from "./client.js";

export type { GhlFoldersClient, GhlFolder } from "./client.js";
export { FolderStore, RecordingGhlClient, type RecordedCall } from "./client.js";

export const ROOT_FOLDER_NAME = "Convert and Flow";
export const CHARACTER_LIBRARY = "Character Library";
export const SERIES = "Series";
export const STANDALONE_MOVIES = "Standalone Movies";

/** Spec §17 Character Library subfolders, in order. */
export const CHARACTER_SUBFOLDERS = [
  "Identity Masters",
  "Expressions",
  "Wardrobe",
  "Voice References",
  "Approved Scene References",
] as const;

/** Spec §17 Series Bible subfolders, in order. */
export const SERIES_BIBLE_SUBFOLDERS = [
  "Characters",
  "Locations",
  "Wardrobe",
  "Props",
] as const;

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

export interface CharacterFolderSpec {
  name: string;
}

export interface EpisodeFolderSpec {
  season: number;
  episode: number;
  title: string;
}

export interface SeriesFolderSpec {
  name: string;
  episodes?: EpisodeFolderSpec[];
}

export interface StandaloneMovieSpec {
  name: string;
}

export interface TreeRequest {
  /** GHL location (sub-account) ID — altId for every call. */
  locationId: string;
  characters?: CharacterFolderSpec[];
  series?: SeriesFolderSpec[];
  standaloneMovies?: StandaloneMovieSpec[];
}

export interface TreeFolderNode {
  name: string;
  /** Slash-separated path from "Convert and Flow" (not including the location). */
  path: string;
  /** GHL folder ID. */
  id: string;
  /** True when the folder already existed (searched, not created). */
  existing: boolean;
  children: TreeFolderNode[];
}

export interface TreeResult {
  root: TreeFolderNode;
  /** Number of folders this run actually created. 0 on a fully-populated tree. */
  createdCount: number;
  /** Total folders in the ensured subtree (root + descendants). */
  totalFolders: number;
}

export interface TreeBuilderOptions {
  client: GhlFoldersClient;
}

/** "S01E01 - Pilot", season/episode zero-padded to two digits. */
export function episodeFolderName(spec: EpisodeFolderSpec): string {
  return `S${pad2(spec.season)}E${pad2(spec.episode)} - ${spec.title}`;
}

export function seasonFolderName(season: number): string {
  return `Season ${pad2(season)}`;
}

function pad2(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new RangeError(`Season/episode number out of range: ${String(n)}`);
  }
  return String(n).padStart(2, "0");
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * Create the tree builder. The client seam is injected so the concrete HTTP
 * adapter (GHL-001/002/003) can be wired in without touching tree logic.
 */
export function createTreeBuilder(options: TreeBuilderOptions): TreeBuilder {
  return new TreeBuilder(options.client);
}

export class TreeBuilder {
  constructor(private readonly client: GhlFoldersClient) {}

  /**
   * Ensure the full §17 tree for the requested location. Search-before-create
   * at every level; safe to call repeatedly (second run creates zero folders).
   */
  async ensureTree(request: TreeRequest): Promise<TreeResult> {
    let createdCount = 0;
    let totalFolders = 0;

    const ensure = async (
      parent: TreeFolderNode,
      name: string,
    ): Promise<TreeFolderNode> => {
      const node = await this.ensureFolder(request.locationId, parent, name);
      parent.children.push(node);
      if (!node.existing) createdCount++;
      totalFolders++;
      return node;
    };

    const root = await this.ensureFolder(request.locationId, undefined, ROOT_FOLDER_NAME);
    if (!root.existing) createdCount++;
    totalFolders++;

    // Character Library
    const characterLibrary = await ensure(root, CHARACTER_LIBRARY);
    for (const character of request.characters ?? []) {
      const characterFolder = await ensure(characterLibrary, character.name);
      for (const sub of CHARACTER_SUBFOLDERS) {
        await ensure(characterFolder, sub);
      }
    }

    // Series
    const seriesRoot = await ensure(root, SERIES);
    for (const series of request.series ?? []) {
      const seriesFolder = await ensure(seriesRoot, series.name);

      const bible = await ensure(seriesFolder, "Series Bible");
      for (const sub of SERIES_BIBLE_SUBFOLDERS) {
        await ensure(bible, sub);
      }

      const seasons = new Map<number, TreeFolderNode>();
      for (const episode of series.episodes ?? []) {
        let seasonFolder = seasons.get(episode.season);
        if (!seasonFolder) {
          seasonFolder = await ensure(seriesFolder, seasonFolderName(episode.season));
          seasons.set(episode.season, seasonFolder);
        }
        const episodeFolder = await ensure(
          seasonFolder,
          episodeFolderName(episode),
        );
        for (const sub of EPISODE_SUBFOLDERS) {
          await ensure(episodeFolder, sub);
        }
      }
    }

    // Standalone Movies (same 01–09 subfolders as episodes)
    const standaloneRoot = await ensure(root, STANDALONE_MOVIES);
    for (const movie of request.standaloneMovies ?? []) {
      const project = await ensure(standaloneRoot, movie.name);
      for (const sub of EPISODE_SUBFOLDERS) {
        await ensure(project, sub);
      }
    }

    return { root, createdCount, totalFolders };
  }

  /**
   * Ensure one folder under `parent` (or at location root when parent is
   * undefined). Exact-name search first; creates only when absent.
   */
  private async ensureFolder(
    locationId: string,
    parent: TreeFolderNode | undefined,
    name: string,
  ): Promise<TreeFolderNode> {
    const parentId = parent?.id;
    const query: FindFoldersQuery = {
      altId: locationId,
      altType: "location",
      name,
      ...(parentId !== undefined ? { parentId } : {}),
    };
    const existing = await this.client.findFolders(query);
    const found = existing[0];
    if (found) {
      return {
        name,
        path: joinPath(parent?.path ?? "", name),
        id: found.id,
        existing: true,
        children: [],
      };
    }

    const input: CreateFolderInput = {
      altId: locationId,
      altType: "location",
      name,
      ...(parentId !== undefined ? { parentId } : {}),
    };
    const created = await this.client.createFolder(input);
    return {
      name,
      path: joinPath(parent?.path ?? "", name),
      id: created.id,
      existing: false,
      children: [],
    };
  }
}