/**
 * Shared types for GHL Media Storage folder operations.
 *
 * Owned by GHL-003 (packages/media-storage/src/ghl/folders/).
 *
 * Auth is deliberately NOT handled here — GHL-001 owns auth/config and supplies
 * prebuilt headers via {@link GhlFolderConfig.headers} or a ready-made
 * {@link GhlTransport}. This module never sees or logs a token.
 *
 * Endpoint facts (verified against official GHL docs 2026-08-28):
 * - Create folder: POST /medias/folder
 *   body: { altId, altType: "location", name, parentId? } (parentId omitted for root)
 * - List files/folders: GET /medias/files
 *   required query: altType=location, altId, type, sortBy/sortOrder; optional:
 *   parentId, limit, offset, query, fetchAll
 * - API base: https://services.leadconnectorhq.com (header: Version: v3)
 */

/** Base URL of the GHL (LeadConnector) services API. */
export const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";

/** altType accepted by GHL media endpoints for sub-account-scoped operations. */
export const GHL_ALT_TYPE_LOCATION = "location" as const;

/** Prebuilt request headers (auth + Version) supplied by GHL-001 auth module. */
export interface GhlFolderConfig {
  /** GHL sub-account (location) ID — sent as `altId`. */
  locationId: string;
  /** Prebuilt headers, e.g. Authorization + Version: v3. Never logged by this module. */
  headers: Record<string, string>;
  /** Override the default API base URL (tests / mocks). */
  baseUrl?: string;
}

/** A single HTTP request as this module issues it. */
export interface GhlTransportRequest {
  method: "GET" | "POST";
  /** Absolute path on the API base, e.g. "/medias/folder". */
  path: string;
  /** Query parameters; `undefined` values are omitted from the URL. */
  query?: Record<string, string | undefined>;
  /** JSON-serializable request body (POST only). */
  body?: unknown;
}

/** Normalized HTTP response. */
export interface GhlTransportResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * HTTP boundary. Implemented by GHL-001's authenticated transport in production
 * and by mocks in tests. Folder logic stays transport-agnostic.
 */
export interface GhlTransport {
  request<T = unknown>(req: GhlTransportRequest): Promise<GhlTransportResponse<T>>;
}

/** Input for folder creation / ensure operations. */
export interface CreateFolderInput {
  /** Folder name. Matched exactly (after trimming) during search-before-create. */
  name: string;
  /** Parent folder ID; omit or `null` to create at the location root. */
  parentId?: string | null;
}

/** A resolved GHL folder with the durable ID callers must persist. */
export interface GhlFolderRecord {
  /** GHL folder ID (from `_id`/`id` in the API payload). Persist this. */
  id: string;
  name: string;
  /** `null` for root-level folders. */
  parentId: string | null;
  /** Location (sub-account) ID the folder belongs to. */
  locationId: string;
  /** Untouched API response payload for provenance/debugging. */
  raw: unknown;
}

/** Result of a search-before-create ensure operation. */
export interface EnsureFolderResult {
  folder: GhlFolderRecord;
  /** True when a new folder was created; false when an existing one was reused. */
  created: boolean;
}