/**
 * Agnes Video 2.5 regular wire-body builder (@mmcs/providers/agnes/profiles/regular).
 *
 * Task AGN-007. Maps the validated camelCase input to the exact Agnes `POST
 * /v1/videos` JSON — field names, `seconds` as a STRING (doc: `"4"`–`"12"`),
 * mode exclusivity already enforced by the validator. Unlike Flash, regular
 * carries a `videos[]` array of {url, start_seconds, require_audio} objects
 * in reference mode.
 */

import { AGNES_REGULAR_MODEL, type AgnesRegularMode } from "./capability.js";
import type {
  AgnesRegularInput,
  AgnesRegularReferenceVideo,
} from "./validate.js";

/** Fields allowed alongside each mode, as documented for regular. */
export interface AgnesRegularModeRule {
  mode: AgnesRegularMode;
  /** Media fields allowed alongside the mode. */
  allows: {
    firstFrame: boolean;
    lastFrame: boolean;
    images: boolean;
    audios: boolean;
    /** Unlike Flash, regular reference mode accepts videos[]. */
    videos: boolean;
  };
}

/** Mode rules as documented (keyframe/reference/text exclusivity). */
export const AGNES_REGULAR_MODE_RULES: Readonly<
  Record<AgnesRegularMode, AgnesRegularModeRule>
> = Object.freeze({
  text: {
    mode: "text",
    allows: {
      firstFrame: false,
      lastFrame: false,
      images: false,
      audios: false,
      videos: false,
    },
  },
  keyframe: {
    mode: "keyframe",
    allows: {
      firstFrame: true,
      lastFrame: true,
      images: false,
      audios: false,
      videos: false,
    },
  },
  reference: {
    mode: "reference",
    allows: {
      firstFrame: false,
      lastFrame: false,
      images: true,
      audios: true,
      videos: true,
    },
  },
});

/** One wire videos[] entry (snake_case as the Agnes API expects). */
export interface AgnesRegularWireReferenceVideo {
  url: string;
  start_seconds?: number;
  require_audio?: boolean;
}

/** The exact wire body for `POST /v1/videos`. */
export interface AgnesRegularRequest {
  model: typeof AGNES_REGULAR_MODEL;
  prompt: string;
  mode: AgnesRegularMode;
  seconds?: string;
  size?: string;
  aspect_ratio?: string;
  first_frame?: string;
  last_frame?: string;
  images?: string[];
  audios?: string[];
  videos?: AgnesRegularWireReferenceVideo[];
  seed?: number;
  n?: number;
}

function toWireVideo(
  video: AgnesRegularReferenceVideo,
): AgnesRegularWireReferenceVideo {
  const wire: AgnesRegularWireReferenceVideo = { url: video.url };
  if (video.startSeconds !== undefined)
    wire.start_seconds = video.startSeconds;
  if (video.requireAudio !== undefined) wire.require_audio = video.requireAudio;
  return wire;
}

/**
 * Build the exact Agnes create-task body for the validated input, or null
 * when the input is invalid (validator must be run first; caller decides).
 */
export function buildAgnesRegularRequest(
  input: AgnesRegularInput,
): AgnesRegularRequest {
  const mode =
    input.mode ??
    (input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined
      ? "keyframe"
      : input.referenceImageUrls?.length ||
          input.referenceAudioUrls?.length ||
          input.referenceVideos?.length
        ? "reference"
        : "text");

  const body: AgnesRegularRequest = {
    model: AGNES_REGULAR_MODEL,
    prompt: input.prompt,
    mode,
  };
  if (input.seconds !== undefined) body.seconds = String(input.seconds);
  if (input.size !== undefined) body.size = input.size;
  if (input.aspectRatio !== undefined) body.aspect_ratio = input.aspectRatio;
  if (input.firstFrameUrl !== undefined) body.first_frame = input.firstFrameUrl;
  if (input.lastFrameUrl !== undefined) body.last_frame = input.lastFrameUrl;
  if (input.referenceImageUrls !== undefined)
    body.images = [...input.referenceImageUrls];
  if (input.referenceAudioUrls !== undefined)
    body.audios = [...input.referenceAudioUrls];
  if (input.referenceVideos !== undefined)
    body.videos = input.referenceVideos.map(toWireVideo);
  if (input.seed !== undefined) body.seed = input.seed;
  body.n = 1;
  return body;
}

/** Character count of the prompt as it will be submitted. */
export function regularPromptCharacterCount(input: AgnesRegularInput): number {
  return input.prompt.length;
}

/**
 * Count billable input images beyond the free allowance (pricing rule, not a
 * cap): max(0, images − 5) × $0.005, per the pricing doc.
 */
export function regularExcessImageCount(input: AgnesRegularInput): number {
  const count = input.referenceImageUrls?.length ?? 0;
  return Math.max(0, count - 5);
}
