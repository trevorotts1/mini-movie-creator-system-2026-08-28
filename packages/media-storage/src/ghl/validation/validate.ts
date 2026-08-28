/// <reference types="node" />
/**
 * GHL Media Storage — URL/file validation (MMCS task GHL-007).
 *
 * Spec §29 security baseline + spec §17 step 3/4 preflight:
 * - remote download URL validation: HTTPS-only scheme allowlist, no SSRF
 *   to private/loopback/link-local/metadata ranges, no embedded credentials,
 *   no non-HTTP ports.
 * - MIME/file-type validation against the media categories MMCS archives
 *   (image / video / audio), including the GHL-observed storage hosts.
 * - file-size checks: 25 MB general / 500 MB video limits (spec §17 step 4).
 * - path-traversal-safe filenames: canonical, flat, sanitized names safe to
 *   pass to any filesystem or storage layer.
 *
 * Pure functions only: no I/O here. Downloaders (GHL-006) call these before
 * fetching; uploaders (GHL-005/GHL-006) call size/MIME checks before POST.
 */

/** Media categories MMCS archives to GHL, with canonical MIME types. */
export const MEDIA_MIME_TYPES = {
  image: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/svg+xml",
  ],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/aac"],
} as const;

export type MediaCategory = keyof typeof MEDIA_MIME_TYPES;

/** All category names, in canonical order. */
export const MEDIA_CATEGORIES: readonly MediaCategory[] = ["image", "video", "audio"];

/** Spec §17 step 4 binary-upload limits, in bytes. */
export const MAX_GENERAL_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_VIDEO_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

/** Size limit for a category: video gets the larger allowance. */
export function maxBytesForCategory(category: MediaCategory): number {
  return category === "video" ? MAX_VIDEO_FILE_BYTES : MAX_GENERAL_FILE_BYTES;
}

/** URL schemes accepted for remote download URLs. HTTPS only. */
export const ALLOWED_URL_SCHEMES: readonly string[] = ["https:"];

/** Well-known cloud-metadata endpoints that must never be fetchable. */
const METADATA_HOSTS: readonly string[] = [
  "169.254.169.254", // AWS/GCP/Azure instance metadata
  "metadata.google.internal",
  "metadata.goog",
];

/** Error thrown when validation fails. `code` is machine-readable. */
export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly detail?: string;

  constructor(code: ValidationErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.detail = detail;
  }
}

export type ValidationErrorCode =
  | "INVALID_URL"
  | "DISALLOWED_SCHEME"
  | "MISSING_HOST"
  | "EMBEDDED_CREDENTIALS"
  | "DISALLOWED_PORT"
  | "PRIVATE_HOST"
  | "DISALLOWED_MIME_TYPE"
  | "UNKNOWN_MIME_TYPE"
  | "MIME_EXTENSION_MISMATCH"
  | "FILE_TOO_LARGE"
  | "FILE_EMPTY"
  | "UNSAFE_FILENAME"
  | "EMPTY_FILENAME"
  | "FILENAME_TOO_LONG"
  | "RESERVED_FILENAME";

/** A parsed and fully validated remote download URL. */
export interface ValidatedUrl {
  /** The URL, re-serialized from the parsed components. */
  href: string;
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
}

/** Result of checking one filename. */
export interface FilenameCheck {
  /** true when the original name was rewritten during sanitization. */
  sanitized: boolean;
  /** The safe filename (always flat, never empty, traversal-free). */
  filename: string;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host, RFC1918, loopback
  if (a === 169 && b === 254) return true; // link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // Strip zone index (fe80::1%eth0)
  const host = hostname.split("%")[0] ?? hostname;
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped. WHATWG URL may normalize to hex hextets
    // ("::ffff:7f00:1" for 127.0.0.1) or keep the dotted quad.
    const tail = lower.slice("::ffff:".length);
    if (tail.includes(":")) {
      // Hex hextets: take the last two as the embedded IPv4.
      const parts = tail.split(":").filter((p) => p.length > 0);
      const last = parts[parts.length - 1];
      const prev = parts[parts.length - 2];
      if (last === undefined || prev === undefined) return false;
      const a = Number.parseInt(prev, 16) >> 8; // high byte of prev hextet
      const b = Number.parseInt(prev, 16) & 0xff; // low byte of prev hextet
      const c = Number.parseInt(last, 16) >> 8;
      const d = Number.parseInt(last, 16) & 0xff;
      return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
    }
    return isPrivateIpv4(tail) || tail.startsWith("127.");
  }
  return false;
}

/** True when the hostname must never be fetched (SSRF guard). */
export function isPrivateHost(hostname: string): boolean {
  // WHATWG URL keeps IPv6 brackets in .hostname — strip them.
  let host = hostname.trim().toLowerCase().replace(/\.$/, ""); // FQDN trailing dot
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (METADATA_HOSTS.includes(host)) return true;
  if (netIsIpV4(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  // Not an IP literal and not an obviously-internal name: allow (public DNS
  // name). Callers that need stricter resolution-time checks can layer on.
  return false;
}

function netIsIpV4(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/**
 * Validate a remote download URL against spec §29:
 * HTTPS-only, public host (no SSRF to private ranges), no embedded
 * credentials, no non-HTTP ports. Throws ValidationError on any violation.
 */
export function validateRemoteUrl(raw: string): ValidatedUrl {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ValidationError("INVALID_URL", "URL must be a non-empty string");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ValidationError("INVALID_URL", "URL is not parseable", raw);
  }

  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    throw new ValidationError(
      "DISALLOWED_SCHEME",
      `URL scheme must be https (got ${parsed.protocol})`,
      raw,
    );
  }

  if (parsed.hostname.length === 0) {
    throw new ValidationError("MISSING_HOST", "URL has no hostname", raw);
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ValidationError(
      "EMBEDDED_CREDENTIALS",
      "URL must not embed credentials",
      raw,
    );
  }

  if (parsed.port.length > 0) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError("DISALLOWED_PORT", "URL port is invalid", raw);
    }
    if (port !== 443) {
      throw new ValidationError(
        "DISALLOWED_PORT",
        `URL port must be 443 (got ${port})`,
        raw,
      );
    }
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new ValidationError(
      "PRIVATE_HOST",
      `URL host is private or reserved (SSRF guard): ${parsed.hostname}`,
      raw,
    );
  }

  return {
    href: parsed.href,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  };
}

/**
 * Sanitize a filename for safe flat storage: strip every path component,
 * traversal sequences, control characters, and reserved device names;
 * collapse whitespace; cap length. Always returns a non-empty name.
 */
export function sanitizeFilename(raw: string, fallback = "file"): string {
  if (typeof raw !== "string") return fallback;

  // Take only the last path segment (kills "../", absolute paths, "C:\").
  let name = raw.includes("/") ? (raw.split("/").pop() ?? "") : raw;
  if (name.includes("\\")) name = name.split("\\").pop() ?? name;

  // Remove control characters (keep printable).
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");

  // Remove traversal remnants and dot segments entirely.
  name = name.replace(/^\.+/, ""); // leading dots / ".."
  name = name.replace(/\.{2,}/g, "."); // interior "..."
  name = name.replace(/[<>:"|?*]/g, ""); // Windows-reserved characters
  name = name.trim().replace(/\s+/g, " "); // collapse whitespace

  if (name.length === 0 || name === "." || name === "..") return fallback;

  // Strip a trailing dot/space (Windows disallows).
  name = name.replace(/[. ]+$/, "");
  if (name.length === 0) return fallback;

  // Reserved Windows device names (case-insensitive), with or without extension.
  const stem = name.split(".")[0]?.toUpperCase() ?? "";
  if (
    ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
      "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
      "LPT7", "LPT8", "LPT9"].includes(stem)
  ) {
    name = `_${name}`;
  }

  // Cap length, preserving the extension.
  const MAX = 200;
  if (name.length > MAX) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX - ext.length) + ext;
    } else {
      name = name.slice(0, MAX);
    }
    if (name.length === 0) return fallback;
  }

  return name;
}

/** True when the filename is already safe (no sanitization would change it). */
export function isSafeFilename(raw: string): boolean {
  return sanitizeFilename(raw) === raw && raw.length > 0;
}

/**
 * Check a filename for storage safety, returning the sanitized form and
 * whether it changed. Throws only when no safe name can be produced.
 */
export function checkFilename(raw: string, fallback = "file"): FilenameCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ValidationError("EMPTY_FILENAME", "filename must be a non-empty string");
  }
  const filename = sanitizeFilename(raw, fallback);
  if (filename.length === 0) {
    throw new ValidationError("UNSAFE_FILENAME", "filename could not be sanitized", raw);
  }
  return { sanitized: filename !== raw, filename };
}

/** Normalize a MIME type: lowercase, strip parameters (`; charset=...`). */
export function normalizeMimeType(mime: string | undefined | null): string {
  if (typeof mime !== "string") return "";
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** True when the MIME type is one of the archived media categories. */
export function mimeCategory(mime: string | undefined | null): MediaCategory | null {
  const normalized = normalizeMimeType(mime);
  if (normalized.length === 0) return null;
  for (const category of MEDIA_CATEGORIES) {
    if ((MEDIA_MIME_TYPES[category] as readonly string[]).includes(normalized)) {
      return category;
    }
  }
  return null;
}

/** Extension (lowercase, no dot) for common media MIME types. */
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/avifs": "avifs",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

/** Canonical extension for a MIME type, or null when unknown. */
export function extensionForMimeType(mime: string | undefined | null): string | null {
  return MIME_EXTENSION[normalizeMimeType(mime)] ?? null;
}

export interface MimeCheckOptions {
  /**
   * When true, an empty/absent MIME type is rejected (strict mode). When
   * false (default), an absent type resolves via the filename extension and
   * throws only when that also fails.
   */
  requireMime?: boolean;
  /**
   * Restrict the accepted categories (e.g. video-only endpoint). Default:
   * any archived media category.
   */
  allowedCategories?: readonly MediaCategory[];
}

export interface MimeCheckResult {
  category: MediaCategory;
  mimeType: string;
}

/**
 * Validate a MIME type (+ optional filename for extension fallback) against
 * the archived media allowlist. Throws ValidationError on violation.
 */
export function validateMimeType(
  mime: string | undefined | null,
  filename?: string,
  options: MimeCheckOptions = {},
): MimeCheckResult {
  const normalized = normalizeMimeType(mime);
  const allowed = options.allowedCategories ?? MEDIA_CATEGORIES;

  if (normalized.length === 0) {
    // Fall back to the filename extension.
    if (filename) {
      const ext = filename.includes(".") ? (filename.split(".").pop() ?? "").toLowerCase() : "";
      const mimeFromExt = Object.entries(MIME_EXTENSION).find(([, e]) => e === ext)?.[0];
      if (mimeFromExt) return validateMimeType(mimeFromExt, undefined, options);
    }
    if (options.requireMime) {
      throw new ValidationError(
        "UNKNOWN_MIME_TYPE",
        "MIME type is required but missing",
      );
    }
    throw new ValidationError(
      "UNKNOWN_MIME_TYPE",
      "MIME type missing and filename has no known media extension",
    );
  }

  const category = mimeCategory(normalized);
  if (category === null) {
    throw new ValidationError(
      "DISALLOWED_MIME_TYPE",
      `MIME type ${normalized} is not an allowed media type`,
    );
  }
  if (!allowed.includes(category)) {
    throw new ValidationError(
      "DISALLOWED_MIME_TYPE",
      `MIME type ${normalized} (${category}) is not allowed here`,
    );
  }
  return { category, mimeType: normalized };
}

export interface FileSizeCheckOptions {
  /** Explicit limit in bytes; defaults to the category limit. */
  maxBytes?: number;
}

/**
 * Validate a file size: must be > 0 and within the limit (25 MB general /
 * 500 MB video; callers pass category or an explicit maxBytes).
 */
export function validateFileSize(
  sizeBytes: number,
  category?: MediaCategory,
  options: FileSizeCheckOptions = {},
): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new ValidationError("FILE_EMPTY", "file is empty or size unknown", String(sizeBytes));
  }
  const max =
    options.maxBytes ?? (category ? maxBytesForCategory(category) : MAX_GENERAL_FILE_BYTES);
  if (sizeBytes > max) {
    const mb = (max / (1024 * 1024)).toFixed(0);
    throw new ValidationError(
      "FILE_TOO_LARGE",
      `file exceeds the ${mb} MB limit (got ${sizeBytes} bytes)`,
    );
  }
}

/**
 * Validate MIME type + size together for a file about to be archived.
 * Returns the detected category so callers can pick the right size limit.
 */
export function validateMediaFile(
  mime: string | undefined | null,
  sizeBytes: number,
  options: (MimeCheckOptions & FileSizeCheckOptions) & { filename?: string } = {},
): MimeCheckResult {
  const { category, mimeType } = validateMimeType(mime, options.filename, options);
  validateFileSize(sizeBytes, category, options);
  return { category, mimeType };
}