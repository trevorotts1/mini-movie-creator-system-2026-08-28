/**
 * AGN-004 — Agnes video submit request shape + payload builder.
 *
 * Request fields mirror the verified Agnes Video 2.5 schema (CAP-002 /
 * docs/provider-capabilities/agnes.md, verified 2026-08-28):
 *   - mode `text` | `keyframe` | `reference`
 *   - `seconds` string "4"–"12" (default "5")
 *   - `size` "720P" | "960P" | "2K" (Flash fixed "720P")
 *   - aspect ratios 21:9/16:9/4:3/1:1/3:4/9:16
 *   - `first_frame`/`last_frame` (keyframe mode, ≥1 required)
 *   - `images[]` (reference mode; Flash max 5), `videos[]`
 *     ({url, start_seconds, require_audio}), `audios[]`
 *
 * The prompt character ceiling stays UNKNOWN (spec §5/§33: never invent an
 * Agnes hard prompt ceiling). `validateAgnesVideoSubmit` therefore records
 * the exact count and consults `hardMaxCharacters` only when non-null.
 */

import type {
  AgnesVideoMode,
  AgnesVideoModelId,
} from "./types.js";

/** The three generation modes as sent to the API. */
export type { AgnesVideoMode };

/** One reference video entry (Agnes reference mode). */
export interface AgnesReferenceVideo {
  url: string;
  /** Seconds into the reference video to draw from. */
  start_seconds?: number;
  /** Whether the reference video's audio track is used. */
  require_audio?: boolean;
}

/** Provider-agnostic input to the submit pipeline (spec §5 chain entry). */
export interface AgnesVideoSubmitInput {
  /** Video prompt. Exact character count recorded pre-request. */
  prompt: string;
  /** Agnes model id; default "agnes-video-2.5-flash" (spec §13 default route). */
  model?: AgnesVideoModelId;
  /** Generation mode. Derived when omitted (text → keyframe → reference). */
  mode?: AgnesVideoMode;
  /** Exact starting frame (keyframe mode). */
  firstFrameUrl?: string;
  /** Exact ending frame (keyframe mode, requires first frame). */
  lastFrameUrl?: string;
  /** Reference images (reference mode; Flash max 5). */
  referenceImageUrls?: readonly string[];
  /** Reference videos (reference mode; regular 2.5 only). */
  referenceVideos?: readonly AgnesReferenceVideo[];
  /** Reference audio URLs (reference mode). */
  referenceAudioUrls?: readonly string[];
  /** "4"–"12" (string per API). Default "5". */
  seconds?: string;
  /** Resolution tier. Flash fixed "720P". */
  size?: "720P" | "960P" | "2K";
  /** Aspect ratio. Default "16:9". */
  aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  /** Output count. Agnes Video 2.5 accepts 1 only. */
  n?: 1;
  /** Integer seed (documented supported). */
  seed?: number;
}

/** Exact Agnes API payload the submitter persists and sends (spec §18). */
export interface AgnesVideoSubmitRequest {
  model: AgnesVideoModelId;
  mode: AgnesVideoMode;
  prompt: string;
  first_frame?: string;
  last_frame?: string;
  images?: string[];
  videos?: AgnesReferenceVideo[];
  audios?: string[];
  seconds: string;
  size: "720P" | "960P" | "2K";
  aspect_ratio: string;
  n: 1;
  seed?: number;
}

/**
 * Classify the dominant mode from the input fields. Explicit `mode` wins;
 * otherwise keyframe when any frame URL is present, reference when any
 * reference array is non-empty, else text. The exclusivity validator still
 * runs on the explicit-mode request — a caller forcing `mode: "keyframe"`
 * with reference images is rejected by the chain, not silently reclassified.
 */
export function classifyMode(
  input: Pick<
    AgnesVideoSubmitInput,
    "firstFrameUrl" | "lastFrameUrl" | "referenceImageUrls" | "referenceVideos" | "referenceAudioUrls"
  >,
): AgnesVideoMode {
  if (
    input.firstFrameUrl !== undefined ||
    input.lastFrameUrl !== undefined
  ) {
    return "keyframe";
  }
  const hasRefs =
    (input.referenceImageUrls?.length ?? 0) > 0 ||
    (input.referenceVideos?.length ?? 0) > 0 ||
    (input.referenceAudioUrls?.length ?? 0) > 0;
  return hasRefs ? "reference" : "text";
}

/**
 * Build the exact Agnes request payload from validated input. Only present
 * fields are emitted (Agnes 400s on contradictory empty arrays, e.g.
 * `videos: []` on Flash: "videos is not supported").
 */
export function buildAgnesVideoSubmitRequest(
  input: AgnesVideoSubmitInput,
): AgnesVideoSubmitRequest {
  const model = input.model ?? "agnes-video-2.5-flash";
  const mode = input.mode ?? classifyMode(input);
  const request: AgnesVideoSubmitRequest = {
    model,
    mode,
    prompt: input.prompt,
    seconds: input.seconds ?? "5",
    size: input.size ?? "720P",
    aspect_ratio: input.aspectRatio ?? "16:9",
    n: 1,
  };
  if (input.firstFrameUrl !== undefined)
    request.first_frame = input.firstFrameUrl;
  if (input.lastFrameUrl !== undefined)
    request.last_frame = input.lastFrameUrl;
  if (input.referenceImageUrls !== undefined && input.referenceImageUrls.length > 0)
    request.images = [...input.referenceImageUrls];
  if (input.referenceVideos !== undefined && input.referenceVideos.length > 0)
    request.videos = input.referenceVideos.map((video) => ({ ...video }));
  if (input.referenceAudioUrls !== undefined && input.referenceAudioUrls.length > 0)
    request.audios = [...input.referenceAudioUrls];
  if (input.n !== undefined) request.n = input.n;
  if (input.seed !== undefined) request.seed = input.seed;
  return request;
}