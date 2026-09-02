import {
  GHL_ALT_TYPE_LOCATION,
  GHL_API_BASE_URL,
  type CreateFolderInput,
  type EnsureFolderResult,
  type GhlFolderConfig,
  type GhlFolderRecord,
  type GhlTransport,
  type GhlTransportRequest,
  type GhlTransportResponse,
} from "./types.js";

export type {
  CreateFolderInput,
  EnsureFolderResult,
  GhlFolderConfig,
  GhlFolderRecord,
  GhlTransport,
  GhlTransportRequest,
  GhlTransportResponse,
} from "./types.js";

export {
  GHL_ALT_TYPE_LOCATION,
  GHL_API_BASE_URL,
} from "./types.js";

/** Thrown when the transport returns a non-2xx status. */
export class GhlFolderApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "GhlFolderApiError";
    this.status = status;
    this.path = path;
  }
}

/** Thrown when the API response is 2xx but missing the fields this module requires. */
export class GhlFolderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhlFolderResponseError";
  }
}

/**
 * Fetch-based {@link GhlTransport} bound to a location's prebuilt auth headers.
 *
 * The headers come from GHL-001's auth module; this class never inspects or
 * logs them. Error messages include status + path only — never headers or
 * request bodies.
 */
export class GhlFetchTransport implements GhlTransport {
  private readonly config: GhlFolderConfig;

  constructor(config: GhlFolderConfig) {
    this.config = config;
  }

  async request<T = unknown>(req: GhlTransportRequest): Promise<GhlTransportResponse<T>> {
    const base = this.config.baseUrl ?? GHL_API_BASE_URL;
    const url = new URL(req.path, base);
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: req.method,
      headers: {
        ...this.config.headers,
        ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(req.method === "POST" && req.body !== undefined
        ? { body: JSON.stringify(req.body) }
        : {}),
    });

    let body: T;
    let parseFailed = false;
    const text = await response.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        parseFailed = true;
        body = {} as T;
      }
    } else {
      body = {} as T;
    }

    if (!response.ok || parseFailed) {
      throw new GhlFolderApiError(
        `GHL request failed: ${req.method} ${req.path} -> ${response.status}`,
        response.status,
        req.path,
      );
    }

    return { status: response.status, body };
  }
}

/**
 * Some GHL list payloads wrap items in a nested "folder" object. Unwrap once so
 * every field read below sees the inner payload.
 */
function unwrapFolderLike(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  if (obj.folder !== null && typeof obj.folder === "object") {
    return obj.folder as Record<string, unknown>;
  }
  return obj;
}

/** Extract the folder id from the loose shapes GHL returns across endpoints. */
function extractFolderId(raw: unknown): string | undefined {
  const obj = unwrapFolderLike(raw);
  const direct = obj.id ?? obj._id ?? obj.folderId ?? obj.folder_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return undefined;
}

/** Normalize an API folder payload into a {@link GhlFolderRecord}. */
function toFolderRecord(raw: unknown, fallbackLocationId: string): GhlFolderRecord {
  if (raw === null || typeof raw !== "object") {
    throw new GhlFolderResponseError("folder payload is not an object");
  }
  const obj = unwrapFolderLike(raw);
  const id = extractFolderId(obj);
  if (id === undefined) {
    throw new GhlFolderResponseError("folder payload missing id (_id/id/folderId)");
  }
  const name = typeof obj.name === "string" ? obj.name : "";
  const parentId =
    typeof obj.parentId === "string" && obj.parentId.length > 0
      ? obj.parentId
      : typeof obj.parent_id === "string" && obj.parent_id.length > 0
        ? obj.parent_id
        : null;
  return {
    id,
    name,
    parentId,
    locationId:
      typeof obj.altId === "string" && obj.altId.length > 0 ? obj.altId : fallbackLocationId,
    raw,
  };
}

/**
 * Create a folder via `POST /medias/folder` and return the normalized record.
 *
 * NOTE: the official create-folder response documents the folder fields but no
 * explicit `id` member; real payloads carry `_id`. If the response omits any id
 * field entirely we surface {@link GhlFolderResponseError} — callers must get a
 * durable ID, never an undefined one.
 */
export async function createFolder(
  transport: GhlTransport,
  config: GhlFolderConfig,
  input: CreateFolderInput,
): Promise<GhlFolderRecord> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new GhlFolderResponseError("folder name must be a non-empty string");
  }

  const body: Record<string, unknown> = {
    altId: config.locationId,
    altType: GHL_ALT_TYPE_LOCATION,
    name,
  };
  if (input.parentId != null && input.parentId.length > 0) {
    body.parentId = input.parentId;
  }

  const { status, body: payload } = await transport.request<unknown>({
    method: "POST",
    path: "/medias/folder",
    body,
  });

  if (status < 200 || status >= 300) {
    throw new GhlFolderApiError(
      `GHL request failed: POST /medias/folder -> ${status}`,
      status,
      "/medias/folder",
    );
  }

  return toFolderRecord(payload, config.locationId);
}

interface ListFilesEnvelope {
  files?: unknown;
  folders?: unknown;
  totalItems?: number;
  currentPage?: number;
  itemsPerPage?: number;
  totalPages?: number;
  [key: string]: unknown;
}

/**
 * List folders directly under `parentId` (or the location root when null).
 * Uses `GET /medias/files` with `type=folder`, paging with offset/limit until
 * the API stops returning items or the documented `totalItems` is reached.
 */
export async function listFolders(
  transport: GhlTransport,
  config: GhlFolderConfig,
  parentId: string | null,
  pageSize = 100,
): Promise<GhlFolderRecord[]> {
  const folders: GhlFolderRecord[] = [];
  let offset = 0;

  for (;;) {
    const { status, body } = await transport.request<ListFilesEnvelope>({
      method: "GET",
      path: "/medias/files",
      query: {
        altType: GHL_ALT_TYPE_LOCATION,
        altId: config.locationId,
        type: "folder",
        sortBy: "name",
        sortOrder: "asc",
        limit: String(pageSize),
        offset: String(offset),
        ...(parentId != null && parentId.length > 0 ? { parentId } : {}),
      },
    });

    if (status < 200 || status >= 300) {
      // Never treat a failed search as "no match" — that would blind-create a
      // duplicate root after a transient API error.
      throw new GhlFolderApiError(
        `GHL request failed: GET /medias/files -> ${status}`,
        status,
        "/medias/files",
      );
    }

    const rawItems: unknown[] = Array.isArray(body.files)
      ? body.files
      : Array.isArray(body.folders)
        ? body.folders
        : [];
    if (rawItems.length === 0 && offset > 0) break;

    for (const item of rawItems) {
      const like = unwrapFolderLike(item);
      const hasId = extractFolderId(item) !== undefined;
      const looksLikeFolder =
        hasId &&
        (like.type === "folder" ||
          like.type === undefined ||
          // list payloads for files carry a url/path; folder payloads do not
          (like.url === undefined && like.url !== null));
      if (hasId && looksLikeFolder) {
        folders.push(toFolderRecord(item, config.locationId));
      }
    }

    if (typeof body.totalItems === "number") {
      if (folders.length >= body.totalItems) break;
    }
    if (rawItems.length < pageSize) break;
    offset += pageSize;
    if (offset > 10_000) {
      // hard stop against pathological pagination
      break;
    }
  }

  return folders;
}

/**
 * Find an existing folder by exact (trimmed) name under `parentId`.
 * Returns `null` when no folder matches exactly.
 */
export async function findFolderByName(
  transport: GhlTransport,
  config: GhlFolderConfig,
  name: string,
  parentId: string | null,
): Promise<GhlFolderRecord | null> {
  const target = name.trim();
  const folders = await listFolders(transport, config, parentId);
  for (const folder of folders) {
    if (folder.name?.trim() === target) return folder;
  }
  return null;
}

/**
 * Search-before-create ensure: return the existing folder matching `name`
 * under `parentId`, creating it only when absent. This is the duplicate-root
 * prevention mechanism required by spec §17 — callers must never
 * create-first.
 */
export async function ensureFolder(
  transport: GhlTransport,
  config: GhlFolderConfig,
  input: CreateFolderInput,
): Promise<EnsureFolderResult> {
  const existing = await findFolderByName(transport, config, input.name, input.parentId ?? null);
  if (existing) {
    return { folder: existing, created: false };
  }
  const folder = await createFolder(transport, config, input);
  return { folder, created: true };
}