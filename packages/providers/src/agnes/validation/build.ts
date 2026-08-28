/**
 * AGN-008 — Agnes request-shape → exact Agnes API payload mapping.
 *
 * Runs only on an already-validated request shape (see validate.ts). Field
 * names are the provider's exact snake_case keys (live docs 2026-08-28):
 * `mode`, `prompt`, `first_frame`, `last_frame`, `images`, `videos`
 * (url/start_seconds/require_audio), `audios`, `seconds`, `size`,
 * `aspect_ratio`.
 */

import type {
  AgnesReferenceVideo,
  AgnesVideoMode,
  AgnesVideoRequestShape,
} from "./types.js";

/** Exact `videos[]` entry of the Agnes API payload. */
export interface AgnesApiReferenceVideo {
  url: string;
  start_seconds?: number;
  require_audio?: boolean;
}

/** The exact request body the Agnes video endpoint accepts. */
export interface AgnesVideoApiRequest {
  model: string;
  mode: AgnesVideoMode;
  prompt: string;
  first_frame?: string;
  last_frame?: string;
  images?: string[];
  audios?: string[];
  videos?: AgnesApiReferenceVideo[];
  /** Provider takes a string ("4"–"12"); numbers are normalized. */
  seconds?: string;
  size?: string;
  aspect_ratio?: string;
}

/**
 * Map a validated request shape onto the exact Agnes payload for `modelId`.
 * Media fields are emitted only for the fields actually present — the
 * provider rejects disallowed fields per mode, and validate.ts guarantees
 * the shape matches the mode before this runs.
 */
export function buildAgnesVideoPayload(
  modelId: string,
  shape: AgnesVideoRequestShape & { mode: AgnesVideoMode },
): AgnesVideoApiRequest {
  const body: AgnesVideoApiRequest = {
    model: modelId,
    mode: shape.mode,
    prompt: shape.prompt ?? "",
  };
  if (isPresent(shape.firstFrameUrl)) body.first_frame = shape.firstFrameUrl;
  if (isPresent(shape.lastFrameUrl)) body.last_frame = shape.lastFrameUrl;
  if (hasEntries(shape.referenceImageUrls))
    body.images = [...shape.referenceImageUrls!];
  if (hasEntries(shape.referenceAudioUrls))
    body.audios = [...shape.referenceAudioUrls!];
  if (hasEntries(shape.referenceVideos))
    body.videos = shape.referenceVideos!.map((video) => {
      const api: AgnesApiReferenceVideo = { url: video.url };
      if (video.startSeconds !== undefined)
        api.start_seconds = video.startSeconds;
      if (video.requireAudio !== undefined)
        api.require_audio = video.requireAudio;
      return api;
    });
  if (shape.seconds !== undefined) {
    body.seconds =
      typeof shape.seconds === "number"
        ? String(shape.seconds)
        : shape.seconds.trim();
  }
  if (shape.size !== undefined) body.size = shape.size;
  if (shape.aspectRatio !== undefined) body.aspect_ratio = shape.aspectRatio;
  return body;
}

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEntries(value: readonly unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}