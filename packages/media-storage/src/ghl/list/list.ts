/**
 * GHL Media Storage — list/search media (MMCS task GHL-002).
 *
 * Wraps `GET /medias/files` (spec.md §17 step 1: find before create).
 *
 * Transport is injected so this module never handles credentials itself
 * (GHL-001 owns auth/config). The caller supplies an `GhlHttp` that already
 * attaches `Authorization: Bearer <token>` and `Version: v3`.
 *
 * API contract (verified 2026-08-28 against the official OpenAPI-generated
 * SDK GoHighLevel/highlevel-api-sdk `lib/code/medias/medias.ts` and its
 * models, corroborated by cbnsndwch/ghl-sdk and mastanley13/GoHighLevel-MCP):
 * - `GET /medias/files` query params: `altType` ('location' | 'agency'),
 *   `altId`, `parentId?`, `type?` ('file' | 'folder'), `query?` (search text),
 *   `sortBy`, `sortOrder` ('asc' | 'desc'), `offset?`, `limit?`,
 *   `fetchAll?`.
 * - Response contains `files` (entries with id/name/parentId/url/path/type/
 *   size/mimeType; some deployments return bare ID strings) plus optional
 *   `total` / `hasMore` pagination hints.
 * - Location access scope required (`Location-Access` security requirement).
 */

/** A file or folder entry returned by `GET /medias/files`. */
export interface GhlMediaEntry {
  id: string;
  name?: string;
  parentId?: string | null;
  /** Canonical download/storage URL (files). */
  url?: string;
  path?: string;
  type: "file" | "folder" | "unknown";
  size?: number;
  mimeType?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Raw response object, preserved verbatim for provenance. */
  raw?: unknown;
}

export interface GhlListPageOptions {
  /** Location (sub-account) ID. `altType` defaults to "location". */
  altId: string;
  altType?: "location" | "agency";
  /** Restrict listing to one parent folder. */
  parentId?: string;
  /** Restrict to files or folders only. */
  type?: "file" | "folder";
  /** Free-text search passed straight to the API. */
  query?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  /** Page size. Defaults to 100 (clamped to >= 1). */
  limit?: number;
}

export interface GhlListPage {
  entries: GhlMediaEntry[];
  total?: number;
  hasMore?: boolean;
  /** Offset to pass to the next call; undefined when no more pages. */
  nextOffset?: number;
}

export interface GhlListAllOptions extends GhlListPageOptions {
  /** Server-side fetch-all instead of client-side paging. */
  fetchAll?: boolean;
  /** Safety cap for client-side paging. Defaults to 100 pages. */
  maxPages?: number;
}

export interface GhlListAllResult {
  entries: GhlMediaEntry[];
  total?: number;
  /**
   * True when the listing stopped before reaching the end. Two cases:
   * (a) the paging cap was hit and `total` proves entries remain, or
   * (b) the cap was hit and the server reported no `total` — the listing is
   *     KNOWN INCOMPLETE even though the remaining count is unknown.
   */
  truncated: boolean;
}

/** Minimal HTTP transport the lister needs. Implementations must attach auth. */
export type GhlHttp = (
  path: string,
  query: Record<string, string>,
) => Promise<unknown>;

/** Error thrown for non-2xx API responses. Never includes auth material. */
export class GhlMediaApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`GHL media API request failed with status ${status}`);
    this.name = "GhlMediaApiError";
    this.status = status;
    // Body may echo request data; keep it but callers must never log secrets.
    this.body = body;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return 100;
  return Math.floor(limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize one response item. The official schema is inconsistent across
 * deployments: items may be full objects or bare ID strings.
 */
export function normalizeMediaEntry(raw: unknown): GhlMediaEntry {
  if (typeof raw === "string") {
    return { id: raw, type: "unknown" };
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const typeRaw = typeof obj.type === "string" ? obj.type : undefined;
    const type: GhlMediaEntry["type"] =
      typeRaw === "file" || typeRaw === "folder" ? typeRaw : "unknown";
    const id = typeof obj.id === "string" ? obj.id : typeof obj._id === "string" ? obj._id : "";
    const entry: GhlMediaEntry = { id, type, raw };
    const name = asString(obj.name);
    if (name !== undefined) entry.name = name;
    if (obj.parentId === null) {
      entry.parentId = null;
    } else if (typeof obj.parentId === "string") {
      entry.parentId = obj.parentId;
    }
    const url = asString(obj.url);
    if (url !== undefined) entry.url = url;
    const path = asString(obj.path);
    if (path !== undefined) entry.path = path;
    if (typeof obj.size === "number") entry.size = obj.size;
    const mimeType = asString(obj.mimeType ?? obj.mimetype);
    if (mimeType !== undefined) entry.mimeType = mimeType;
    const createdAt = asString(obj.createdAt);
    if (createdAt !== undefined) entry.createdAt = createdAt;
    const updatedAt = asString(obj.updatedAt);
    if (updatedAt !== undefined) entry.updatedAt = updatedAt;
    return entry;
  }
  throw new TypeError("GHL media list: unrecognizable entry in response");
}

/** Parse one `GET /medias/files` response body. */
export function parseMediaListResponse(body: unknown): {
  entries: GhlMediaEntry[];
  total?: number;
  hasMore?: boolean;
} {
  if (body === null || typeof body !== "object") {
    throw new TypeError("GHL media list: response is not an object");
  }
  const obj = body as Record<string, unknown>;
  const filesRaw = obj.files;
  if (!Array.isArray(filesRaw)) {
    throw new TypeError('GHL media list: response missing "files" array');
  }
  const entries = filesRaw.map(normalizeMediaEntry);
  const total = typeof obj.total === "number" ? obj.total : undefined;
  const hasMore = typeof obj.hasMore === "boolean" ? obj.hasMore : undefined;
  return { entries, total, hasMore };
}

function buildQuery(options: GhlListPageOptions): Record<string, string> {
  const query: Record<string, string> = {
    altType: options.altType ?? "location",
    altId: options.altId,
    sortBy: options.sortBy ?? "name",
    sortOrder: options.sortOrder ?? "asc",
  };
  if (options.parentId !== undefined) query.parentId = options.parentId;
  if (options.type !== undefined) query.type = options.type;
  if (options.query !== undefined) query.query = options.query;
  return query;
}

/**
 * Fetch a single page. `limit`/`offset` are added by the paging helpers or by
 * the caller when it manages pagination itself.
 */
export async function listMediaPage(
  http: GhlHttp,
  options: GhlListPageOptions & { offset?: number },
): Promise<GhlListPage> {
  const limit = clampLimit(options.limit);
  const query: Record<string, string> = {
    ...buildQuery(options),
    limit: String(limit),
  };
  if (options.offset !== undefined && options.offset > 0) {
    query.offset = String(options.offset);
  }
  const body = await http("/medias/files", query);
  const parsed = parseMediaListResponse(body);
  const fullPage = parsed.entries.length >= limit;
  const hasMore = parsed.hasMore ?? fullPage;
  const total = parsed.total;
  return {
    entries: parsed.entries,
    total,
    hasMore,
    nextOffset: hasMore ? (options.offset ?? 0) + parsed.entries.length : undefined,
  };
}

/**
 * List media with pagination handled. By default pages client-side with
 * `limit`/`offset` until a short page (or explicit `hasMore: false` /
 * `total` reached). With `fetchAll: true` a single server-side request is
 * made (`fetchAll=true` query param, per the official API).
 */
export async function listMedia(
  http: GhlHttp,
  options: GhlListAllOptions = { altId: "" },
): Promise<GhlListAllResult> {
  if (options.fetchAll === true) {
    const query = buildQuery(options);
    query.fetchAll = "true";
    const body = await http("/medias/files", query);
    const parsed = parseMediaListResponse(body);
    return { entries: parsed.entries, total: parsed.total, truncated: false };
  }

  const limit = clampLimit(options.limit);
  const maxPages = options.maxPages ?? 100;
  const all: GhlMediaEntry[] = [];
  let offset = 0;
  let total: number | undefined;
  let capped = false;
  for (let page = 0; page < maxPages; page++) {
    const one = await listMediaPage(http, { ...options, limit, offset });
    all.push(...one.entries);
    if (one.total !== undefined) total = one.total;
    if (one.hasMore === false) break;
    if (total !== undefined && all.length >= total) break;
    if (one.entries.length < limit) break;
    if (one.entries.length === 0) break;
    offset += one.entries.length;
    if (page === maxPages - 1) capped = true;
  }
  const truncated =
    capped || (all.length > 0 && total !== undefined && all.length < total);
  return { entries: all, total, truncated };
}

/**
 * Resolve a folder by EXACT name (case-sensitive, no normalization) within
 * the location, optionally scoped to a parent folder. Returns the matching
 * folder entry or null when absent — callers (GHL-003/GHL-004) use this for
 * search-before-create.
 *
 * A null is a claim "this folder does not exist", so a paging cap hit is NOT
 * null (that would cause callers to create a duplicate root). It throws
 * `GhlMediaListTruncatedError` instead — the search was inconclusive.
 */
export async function findFolderByName(
  http: GhlHttp,
  name: string,
  options: Omit<GhlListPageOptions, "type" | "query"> = { altId: "" },
): Promise<GhlMediaEntry | null> {
  const maxPages = 100;
  let offset: number | undefined;
  for (let pagesFetched = 0; pagesFetched < maxPages; pagesFetched++) {
    const page = await listMediaPage(http, {
      ...options,
      type: "folder",
      limit: options.limit ?? 100,
      ...(offset !== undefined ? { offset } : {}),
    });
    for (const entry of page.entries) {
      if (entry.type === "folder" && entry.name === name) return entry;
    }
    offset = page.nextOffset;
    if (offset === undefined) return null;
  }
  // Cap exhausted without exhausting the listing: inconclusive, not "absent".
  throw new GhlMediaListTruncatedError(maxPages, name);
}

/** Thrown when folder search hit the paging cap without exhausting the listing. */
export class GhlMediaListTruncatedError extends Error {
  readonly maxPages: number;
  readonly folderName: string;

  constructor(maxPages: number, folderName: string) {
    super(
      `GHL media list: folder search for "${folderName}" hit the ${maxPages}-page cap before the listing was exhausted; result inconclusive (treat as "unknown", not "absent")`,
    );
    this.name = "GhlMediaListTruncatedError";
    this.maxPages = maxPages;
    this.folderName = folderName;
  }
}

/**
 * Resolve a nested folder path segment-by-segment with exact names
 * (`["Convert and Flow", "Series"]`). Returns null as soon as any segment is
 * missing. Purely read-only — creation belongs to GHL-003/GHL-004.
 */
export async function findFolderPath(
  http: GhlHttp,
  segments: readonly string[],
  options: { altId: string; altType?: "location" | "agency"; limit?: number } = {
    altId: "",
  },
): Promise<GhlMediaEntry | null> {
  let parent: string | undefined;
  let matched: GhlMediaEntry | null = null;
  for (const segment of segments) {
    const hit = await findFolderByName(http, segment, {
      altId: options.altId,
      altType: options.altType,
      limit: options.limit,
      parentId: parent,
    });
    if (hit === null) return null;
    matched = hit;
    parent = hit.id;
  }
  return matched;
}