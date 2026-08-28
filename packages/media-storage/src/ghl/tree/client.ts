/**
 * Client seam for the GHL folder tree (spec §17). The tree builder depends on
 * this interface only — the concrete HTTP adapter (GHL-001/002/003:
 * auth + list + folders) plugs in here, so tree logic is testable against a
 * mocked API that records calls.
 *
 * Mapping to the spec §17 request sequence:
 *  - findFolders   → GET /medias/files (location context: altType=location, altId),
 *                    searched for the exact folder name before any create.
 *  - createFolder  → POST /medias/folder {altId, altType: "location", name, parentId?}.
 */
export interface GhlFolder {
  /** GHL folder ID as returned by the API. */
  id: string;
  name: string;
  /** Parent folder ID; undefined for location-root-level folders. */
  parentId?: string;
}

export interface FindFoldersQuery {
  /** Location (sub-account) context — spec: altType=location, altId. */
  altId: string;
  altType: "location";
  /** Exact folder name to match. Search must be exact, never partial. */
  name: string;
  /** Restrict the search to children of this folder (nested levels). */
  parentId?: string;
}

export interface CreateFolderInput {
  altId: string;
  altType: "location";
  name: string;
  parentId?: string;
}

export interface GhlFoldersClient {
  /** Search existing folders by exact name within the location/parent scope. */
  findFolders(query: FindFoldersQuery): Promise<GhlFolder[]>;
  /** Create a folder; returns the persisted folder ID. */
  createFolder(input: CreateFolderInput): Promise<GhlFolder>;
}

/** In-memory GHL folder store backing the recording mock. */
export class FolderStore {
  private folders = new Map<string, { id: string; name: string; parentId?: string }>();
  private nextId = 1;

  createFolder(name: string, parentId?: string): GhlFolder {
    const id = `fld_${this.nextId++}`;
    const folder = { id, name, parentId };
    this.folders.set(id, folder);
    return { ...folder };
  }

  /** Exact-name lookup (no case folding, no partial match). */
  findExact(name: string, parentId?: string): GhlFolder | undefined {
    for (const folder of this.folders.values()) {
      if (folder.name !== name) continue;
      if ((folder.parentId ?? undefined) !== (parentId ?? undefined)) continue;
      return { ...folder };
    }
    return undefined;
  }

  listChildren(parentId?: string): GhlFolder[] {
    const out: GhlFolder[] = [];
    for (const folder of this.folders.values()) {
      if ((folder.parentId ?? undefined) === (parentId ?? undefined)) {
        out.push({ ...folder });
      }
    }
    return out;
  }
}

export type RecordedCall =
  | { kind: "search"; query: FindFoldersQuery }
  | {
      kind: "create";
      body: CreateFolderInput;
      result?: GhlFolder;
    };

/**
 * Mocked client that records every call in order (for "second run creates
 * zero duplicates" assertions) and keeps API state in a FolderStore.
 * Store is replaceable so a second builder instance can run against the
 * same populated API state.
 */
export class RecordingGhlClient implements GhlFoldersClient {
  readonly calls: RecordedCall[] = [];
  store: FolderStore = new FolderStore();

  async findFolders(query: FindFoldersQuery): Promise<GhlFolder[]> {
    this.calls.push({ kind: "search", query: { ...query } });
    const found = this.store.findExact(query.name, query.parentId);
    return found ? [found] : [];
  }

  async createFolder(input: CreateFolderInput): Promise<GhlFolder> {
    const created = this.store.createFolder(input.name, input.parentId);
    this.calls.push({ kind: "create", body: { ...input }, result: { ...created } });
    return created;
  }

  get createdCount(): number {
    return this.calls.filter((c) => c.kind === "create").length;
  }
}