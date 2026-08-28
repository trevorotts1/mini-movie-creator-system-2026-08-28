/**
 * Media kind classification for size limits and verification (spec §17.4).
 * The GHL upload endpoint enforces 25 MB for general files and 500 MB for
 * video; every other kind (image/audio/generic) rides the general limit.
 */
export type MediaKind = "video" | "image" | "audio" | "generic";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

/** Best-effort MIME type from the deterministic file name; octet-stream fallback. */
export function contentTypeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = name.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}