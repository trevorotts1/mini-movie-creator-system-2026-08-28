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
 */
import { listMediaPage, type GhlHttp } from "../ghl/list/index.js";
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
    const page = await listMediaPage(this.http, {
      altId: query.altId,
      altType: query.altType,
      parentId: query.parentId,
      type: "folder",
      // One exact-name page is the spec's search; server-side `query` search is
      // NOT exact on every deployment, so filter client-side on exact name.
      limit: 100,
    });
    return page.entries
      .filter((entry) => entry.type === "folder" && entry.name === query.name)
      .filter((entry) =>
        // Defense-in-depth: the server should honor parentId, but a stale or
        // loosely-scoped deployment must not adopt a same-named folder under a
        // different parent (duplicate-tree hazard).
        query.parentId === undefined || entry.parentId === query.parentId,
      )
      .map((entry) => {
        if (entry.id.length === 0) {
          throw new Error(`GHL folder search "${query.name}": entry missing id`);
        }
        const folder: GhlFolder = { id: entry.id, name: entry.name as string };
        if (entry.parentId !== undefined && entry.parentId !== null) {
          folder.parentId = entry.parentId;
        }
        return folder;
      });
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
