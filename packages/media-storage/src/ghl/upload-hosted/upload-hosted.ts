/// <reference types="node" />
/**
 * GHL Media Storage — hosted URL ingest (MMCS task GHL-005).
 *
 * Wraps `POST /medias/upload-file` with `hosted=true` (spec.md §17 step 3 /
 * runbook §14.3): hand GoHighLevel a temporary provider URL and let it fetch
 * the bytes server-side, so the asset is archived before the provider URL
 * expires. The caller resolves the destination folder (GHL-004 owns the tree)
 * and persists the returned fileId + storage URL (GHL-008 owns the manifest).
 *
 * Transport is injected so this module never handles credentials itself
 * (GHL-001 owns auth/config). `GhlUploadHttp` implementations must attach
 * `Authorization: Bearer <token>` and `Version: v3` and never log the token.
 *
 * API contract (verified 2026-08-28 against the official GHL Media Storage
 * docs — marketplace.gohighlevel.com/docs/ghl/medias — and the
 * OpenAPI-generated SDK GoHighLevel/highlevel-api-sdk, corroborated by
 * cbnsndwch/ghl-sdk):
 * - `POST /medias/upload-file` multipart/form-data fields:
 *   `hosted=true`, `fileUrl=<public URL>`, `name=<deterministic canonical
 *   filename>`, `parentId=<destination folder>`, plus optional location
 *   context `altId` / `altType` when the caller supplies it.
 * - Success returns the stored media record: `fileId` (deployment variants:
 *   `id` / `_id` / `mediaId`) and the storage `url` (variants: `mediaUrl` /
 *   `fileUrl` / `link`).
 * - A returned URL is not trusted as durable until probed: reachability is
 *   verified BEFORE this module reports ARCHIVED (spec: "verify the GHL URL
 *   is reachable → mark ARCHIVED"). On missing/unreachable URL the caller
 *   falls back to binary upload (GHL-006); the error carries the fileId so
 *   the fallback can reference the partial record. Media Storage
 *   read/write permissions and Location access scope required.
 */

/** Multipart POST transport. Implementations attach auth headers. */
export type GhlUploadHttp = (path: string, body: FormData) => Promise<unknown>;

/** Destination + source for one hosted ingest. */
export interface HostedIngestRequest {
  /** Temporary provider URL GHL will fetch server-side. http/https only. */
  fileUrl: string;
  /**
   * Human/source name to canonicalize. Sanitized into a deterministic
   * canonical filename (path-traversal safe, single lowercase extension).
   */
  name: string;
  /** Destination GHL folder ID (episode/character folder). */
  parentId: string;
  /** Location (sub-account) context, passed through when supplied. */
  altId?: string;
  altType?: "location" | "agency";
}

/** Successful, reachability-verified archival result. */
export interface HostedArchiveResult {
  status: "ARCHIVED";
  fileId: string;
  /** Verified storage URL — safe to persist as the durable asset URL. */
  url: string;
  /** Canonical filename sent to GHL (deterministic for identical inputs). */
  name: string;
  /** Raw response object, preserved verbatim for provenance. */
  raw?: unknown;
}

export type GhlIngestErrorCode =
  | "INVALID_FILE_URL"
  | "MISSING_URL"
  | "UNREACHABLE";

/** Ingest failure that leaves a usable partial record (e.g. for GHL-006 fallback). */
export class GhlIngestError extends Error {
  readonly code: GhlIngestErrorCode;
  readonly fileId?: string;
  readonly url?: string;
  /** HTTP status the reachability probe observed, when it got one. */
  readonly probeStatus?: number;

  constructor(
    code: GhlIngestErrorCode,
    message: string,
    context: { fileId?: string; url?: string; probeStatus?: number } = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "GhlIngestError";
    this.code = code;
    this.fileId = context.fileId;
    this.url = context.url;
    this.probeStatus = context.probeStatus;
  }
}

/** Minimal structural response the URL probe needs (fetch-compatible). */
export interface UrlProbeResponse {
  ok: boolean;
  status: number;
}

export type UrlProbe = (
  url: string,
  init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
) => Promise<UrlProbeResponse>;

/**
 * Probe outcome with the observed HTTP status, so callers can attach
 * diagnostics (e.g. `GhlIngestError.probeStatus`) without re-probing.
 */
export interface UrlProbeResult {
  reachable: boolean;
  /** HTTP status observed by the probe; undefined on network error/timeout. */
  status?: number;
}

/** Parts may be strings/numbers; undefined/null parts are dropped. */
export type CanonicalPart = string | number | undefined | null;

const DEFAULT_MAX_NAME_LENGTH = 200;
const ALLOWED_NAME_CHARS = /[^A-Za-z0-9._-]+/g;

function sanitizeSegment(part: string): string {
  // Kill any path structure first — never let a name escape its folder.
  const noPath = part.split(/[/\\]+/).pop() ?? "";
  return noPath
    .replace(ALLOWED_NAME_CHARS, "_") // control chars, spaces, unicode → "_"
    .replace(/_{2,}/g, "_")
    .replace(/-+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
}

/**
 * Build a deterministic canonical filename per spec §48:
 * parts joined with "_", sanitized to [A-Za-z0-9._-], single lowercase
 * extension, no path components, capped length. Same input → same output
 * (no timestamps, no randomness).
 *
 * Example:
 *   buildCanonicalName(["S01E03","SC04","SH07","monica closeup","agnes25","v03.MP4"])
 *   → "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4"
 */
export function buildCanonicalName(
  parts: readonly CanonicalPart[],
  options: { maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_NAME_LENGTH;
  const joined = parts
    .map((part) => (part === undefined || part === null ? "" : String(part)))
    .filter((part) => part.length > 0)
    .join("_");
  if (joined.length === 0) {
    throw new TypeError("canonical name: at least one non-empty part required");
  }
  const extMatch = /\.([A-Za-z0-9]{1,8})$/.exec(joined);
  const ext: string | undefined =
    extMatch && extMatch.length > 1 ? extMatch[1]?.toLowerCase() : undefined;
  const base = ext ? joined.slice(0, joined.length - ext.length - 1) : joined;
  const cleanBase = sanitizeSegment(base);
  if (cleanBase.length === 0) {
    throw new TypeError("canonical name: parts sanitized to empty");
  }
  const full = ext ? `${cleanBase}.${ext}` : cleanBase;
  if (full.length <= maxLength) return full;
  const keepBase = maxLength - (ext ? ext.length + 1 : 0);
  if (keepBase <= 0) {
    throw new TypeError(
      `canonical name: maxLength ${maxLength} cannot fit ".${ext}" extension`,
    );
  }
  return ext
    ? `${cleanBase.slice(0, keepBase)}.${ext}`
    : cleanBase.slice(0, maxLength);
}

/**
 * Derive a raw name from a URL's final path segment (query string dropped,
 * percent-encoding decoded best-effort). Returns undefined when the URL has
 * no usable basename. Callers pass the result through `buildCanonicalName`.
 */
export function nameFromUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const last: string | undefined =
    segments.length > 0 ? segments[segments.length - 1] : undefined;
  if (last === undefined) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Parse one `POST /medias/upload-file` response body. */
export function parseUploadResponse(body: unknown): {
  fileId: string;
  url?: string;
} {
  if (typeof body === "string") {
    if (body.length === 0) {
      throw new TypeError("GHL upload: empty response body");
    }
    // Some deployments answer with the bare file ID string.
    return { fileId: body };
  }
  if (body === null || typeof body !== "object") {
    throw new TypeError("GHL upload: response is not an object");
  }
  const obj = body as Record<string, unknown>;
  const nested = obj.data ?? obj.file ?? obj.media;
  const sources: Array<Record<string, unknown>> =
    nested !== null && typeof nested === "object"
      ? [obj, nested as Record<string, unknown>]
      : [obj];
  const pick = (key: string): string | undefined => {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  const fileId =
    pick("fileId") ?? pick("id") ?? pick("_id") ?? pick("mediaId");
  if (fileId === undefined) {
    throw new TypeError("GHL upload: response missing fileId");
  }
  const url =
    pick("url") ?? pick("fileUrl") ?? pick("mediaUrl") ?? pick("link");
  return url === undefined ? { fileId } : { fileId, url };
}

/** Build the multipart body for `POST /medias/upload-file` (hosted flow). */
export function buildMultipartBody(
  request: HostedIngestRequest,
  canonicalName: string,
): FormData {
  const form = new FormData();
  form.set("hosted", "true");
  form.set("fileUrl", request.fileUrl);
  form.set("name", canonicalName);
  form.set("parentId", request.parentId);
  if (request.altId !== undefined) {
    form.set("altId", request.altId);
    form.set("altType", request.altType ?? "location");
  }
  return form;
}

function defaultProbe(
  url: string,
  init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
): Promise<UrlProbeResponse> {
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    return Promise.resolve({ ok: false, status: 0 });
  }
  return fetchImpl(url, {
    method: init?.method,
    signal: init?.signal,
  }) as unknown as Promise<UrlProbeResponse>;
}

export interface VerifyUrlOptions {
  probe?: UrlProbe;
  /** HEAD by default; GET for CDNs that reject HEAD. */
  method?: "HEAD" | "GET";
  /** Probe timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
}

/**
 * Probe a URL once and report reachability plus the observed HTTP status.
 * Network errors, timeouts and non-2xx all count as unreachable — never an
 * ARCHIVED signal — but the status is preserved for diagnostics.
 */
export async function probeUrl(
  url: string,
  options: VerifyUrlOptions = {},
): Promise<UrlProbeResult> {
  const probe = options.probe ?? defaultProbe;
  const method = options.method ?? "HEAD";
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const response = await probe(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      reachable:
        response.ok && response.status >= 200 && response.status < 300,
      status: response.status,
    };
  } catch {
    return { reachable: false };
  }
}

/**
 * Probe whether a URL is reachable (any 2xx). Network errors, timeouts and
 * non-2xx all count as unreachable — never an ARCHIVED signal.
 */
export async function verifyUrlReachable(
  url: string,
  options: VerifyUrlOptions = {},
): Promise<boolean> {
  return (await probeUrl(url, options)).reachable;
}

function assertHttpUrl(fileUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new GhlIngestError("INVALID_FILE_URL", `fileUrl is not a URL: unparseable input`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GhlIngestError(
      "INVALID_FILE_URL",
      `fileUrl scheme must be http/https, got ${parsed.protocol}`,
    );
  }
}

export interface ArchiveHostedOptions {
  /** Reachability probe override (tests inject a fake; default is fetch). */
  probe?: UrlProbe;
  probeMethod?: "HEAD" | "GET";
  probeTimeoutMs?: number;
  /** Canonical-name length cap. Defaults to 200. */
  maxNameLength?: number;
}

/**
 * Archive a temporary provider URL into GHL via the hosted flow:
 * POST /medias/upload-file (hosted=true, fileUrl, canonical name, parentId)
 * → parse fileId + storage URL → verify the GHL URL is reachable → only then
 * report ARCHIVED. Anything short of a verified reachable URL throws
 * GhlIngestError (carrying fileId when known) so the caller can run the
 * binary fallback (GHL-006) — never regenerate the asset, never mark
 * ARCHIVED unverified.
 */
export async function archiveHostedUrl(
  http: GhlUploadHttp,
  request: HostedIngestRequest,
  options: ArchiveHostedOptions = {},
): Promise<HostedArchiveResult> {
  assertHttpUrl(request.fileUrl);
  const canonicalName = buildCanonicalName([request.name], {
    maxLength: options.maxNameLength,
  });
  const form = buildMultipartBody(request, canonicalName);
  const raw = await http("/medias/upload-file", form);
  const parsed = parseUploadResponse(raw);
  if (parsed.url === undefined) {
    throw new GhlIngestError(
      "MISSING_URL",
      "GHL upload response carried no storage URL; binary fallback required",
      { fileId: parsed.fileId },
    );
  }
  const probeResult = await probeUrl(parsed.url, {
    probe: options.probe,
    method: options.probeMethod,
    timeoutMs: options.probeTimeoutMs,
  });
  if (!probeResult.reachable) {
    throw new GhlIngestError(
      "UNREACHABLE",
      "GHL storage URL failed reachability verification; binary fallback required",
      {
        fileId: parsed.fileId,
        url: parsed.url,
        probeStatus: probeResult.status,
      },
    );
  }
  return {
    status: "ARCHIVED",
    fileId: parsed.fileId,
    url: parsed.url,
    name: canonicalName,
    raw,
  };
}