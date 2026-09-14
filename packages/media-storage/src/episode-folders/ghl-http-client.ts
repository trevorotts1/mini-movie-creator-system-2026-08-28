/**
 * Concrete `EpisodeFoldersClient` adapter over the merged GHL-002 lister
 * (`GET /medias/files`) and `POST /medias/folder` (spec §17 step 2).
 *
 * The transport seam is the GHL-001/GHL-002 `GhlHttp` type (path + query,
 * auth already attached), so this module never sees credentials.
 *
 * Verified request shapes (spec.md §17, corroborating the GHL-002 module doc):
 *  - Search: GET /medias/files with altType=location, altId, parentId, type=folder.
 *  - Create: POST /medias/folder body {altId, altType: "location", name, parentId?}.
 *
 * SKR-014: the search delegates to the GHL-002 `findFolderByName`, which pages
 * the whole listing and refuses to answer "absent" when its page cap is hit.
 * Fetching a single `limit: 100` page here made an existing folder look absent
 * under a parent with more children than one page, so the caller created a
 * duplicate folder.
 */
import { findFolderByName, type GhlHttp } from "../ghl/list/index.js";
import type {
  CreateFolderInput,
  EpisodeFoldersClient,
  FindFoldersQuery,
  GhlFolder,
} from "./types.js";

/** POST body shape for folder creation (spec §17 step 2). */
interface CreateFolderBody {
  altId: string;
  altType: "location";
  name: string;
  parentId?: string;
}

/**
 * Extended transport: same auth contract as `GhlHttp` plus an optional body
 * for POST. A plain `GhlHttp` still satisfies this — it simply ignores the
 * second argument, and `createFolder` would then fail its response check
 * instead of silently succeeding (fail-loud beats fail-wrong).
 */
export type EpisodeFoldersHttp = (
  path: string,
  query: Record<string, string>,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

function isFolderLike(value: unknown): value is { id: string; name: string; parentId?: string } {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.name === "string";
}

export class GhlHttpEpisodeFoldersClient implements EpisodeFoldersClient {
  constructor(private readonly http: EpisodeFoldersHttp) {}

  async findFolders(query: FindFoldersQuery): Promise<GhlFolder[]> {
    // Exact-name search over the WHOLE folder listing (all pages; a cap hit
    // throws GhlMediaListTruncatedError rather than claiming "absent").
    const match = await findFolderByName(this.http, query.name, {
      altId: query.altId,
      altType: query.altType,
      parentId: query.parentId,
      // Defense-in-depth: the server should honor parentId, but a stale or
      // loosely-scoped deployment must not adopt a same-named folder under a
      // different parent (duplicate-tree hazard).
      match:
        query.parentId === undefined
          ? undefined
          : (entry) => entry.parentId === query.parentId,
    });
    if (match === null) return [];
    if (match.id.length === 0) {
      throw new Error(`GHL folder search "${query.name}": entry missing id`);
    }
    const folder: GhlFolder = { id: match.id, name: match.name as string };
    if (match.parentId !== undefined && match.parentId !== null) {
      folder.parentId = match.parentId;
    }
    return [folder];
  }

  async createFolder(input: CreateFolderInput): Promise<GhlFolder> {
    const body: CreateFolderBody = {
      altId: input.altId,
      altType: input.altType,
      name: input.name,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    };
    const raw = await this.http("/medias/folder", {}, { method: "POST", body });
    if (!isFolderLike(raw)) {
      throw new Error(
        `GHL create folder "${input.name}": unexpected response shape (expected {id, name})`,
      );
    }
    const folder: GhlFolder = { id: raw.id, name: raw.name };
    if (raw.parentId !== undefined) folder.parentId = raw.parentId;
    return folder;
  }
}

/** Re-export so callers can type a transport as plain `GhlHttp` if they wish. */
export type { GhlHttp };
