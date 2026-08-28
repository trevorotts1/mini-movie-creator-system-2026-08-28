/**
 * Size limits — spec §17.4: 25 MB general / 500 MB video.
 */
import type { MediaKind } from "./media-kind.js";

export const GENERAL_LIMIT_BYTES = 25 * 1024 * 1024;
export const VIDEO_LIMIT_BYTES = 500 * 1024 * 1024;

export function limitForKind(kind: MediaKind): number {
  return kind === "video" ? VIDEO_LIMIT_BYTES : GENERAL_LIMIT_BYTES;
}