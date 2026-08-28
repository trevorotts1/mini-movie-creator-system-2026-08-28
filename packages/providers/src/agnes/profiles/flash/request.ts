/**
 * Agnes Video 2.5 Flash wire-body builder (@mmcs/providers/agnes/profiles/flash).
 *
 * Task AGN-006. Maps the validated camelCase input to the exact Agnes `POST
 * /v1/videos` JSON — field names, `seconds` as a STRING (doc: `"4"`–`"12"`),
 * mode exclusivity already enforced by the validator.
 */

import { AGNES_FLASH_MODEL, type AgnesFlashMode } from "./capability.js";
import type { AgnesFlashInput } from "./validate.js";

/** Fields accepted by the Agnes create-task endpoint (Flash). */
export interface AgnesFlashModeRule {
  mode: AgnesFlashMode;
  /** Media fields allowed alongside the mode. */
  allows: {
    firstFrame: boolean;
    lastFrame: boolean;
    images: boolean;
    audios: boolean;
    videos: boolean;
  };
}

/** Mode rules as documented (keyframe/reference/text exclusivity). */
export const AGNES_FLASH_MODE_RULES: Readonly<Record<AgnesFlashMode, AgnesFlashModeRule>> =
  Object.freeze({
    text: {
      mode: "text",
      allows: { firstFrame: false, lastFrame: false, images: false, audios: false, videos: false },
    },
    keyframe: {
      mode: "keyframe",
      allows: { firstFrame: true, lastFrame: true, images: false, audios: false, videos: false },
    },
    reference: {
      mode: "reference",
      allows: { firstFrame: false, lastFrame: false, images: true, audios: true, videos: false },
    },
  });

/** The exact wire body for `POST /v1/videos`. */
export interface AgnesFlashRequest {
  model: typeof AGNES_FLASH_MODEL;
  prompt: string;
  mode: AgnesFlashMode;
  seconds?: string;
  size?: string;
  aspect_ratio?: string;
  first_frame?: string;
  last_frame?: string;
  images?: string[];
  audios?: string[];
  seed?: number;
  n?: number;
}

/**
 * Build the exact Agnes create-task body for the validated input, or null
 * when the input is invalid (validator must be run first; caller decides).
 */
export function buildAgnesFlashRequest(input: AgnesFlashInput): AgnesFlashRequest {
  const mode =
    input.mode ??
    (input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined
      ? "keyframe"
      : input.referenceImageUrls?.length ||
          input.referenceAudioUrls?.length ||
          input.referenceVideoUrls?.length
        ? "reference"
        : "text");

  const body: AgnesFlashRequest = {
    model: AGNES_FLASH_MODEL,
    prompt: input.prompt,
    mode,
  };
  if (input.seconds !== undefined) body.seconds = String(input.seconds);
  if (input.size !== undefined) body.size = input.size;
  if (input.aspectRatio !== undefined) body.aspect_ratio = input.aspectRatio;
  if (input.firstFrameUrl !== undefined) body.first_frame = input.firstFrameUrl;
  if (input.lastFrameUrl !== undefined) body.last_frame = input.lastFrameUrl;
  // Empty arrays are never serialized: mode=text forbids an images/audios
  // field outright, and an empty array carries no reference information.
  if (input.referenceImageUrls !== undefined && input.referenceImageUrls.length > 0)
    body.images = [...input.referenceImageUrls];
  if (input.referenceAudioUrls !== undefined && input.referenceAudioUrls.length > 0)
    body.audios = [...input.referenceAudioUrls];
  if (input.seed !== undefined) body.seed = input.seed;
  body.n = 1;
  return body;
}

/** Character count of the prompt as it will be submitted. */
export function flashPromptCharacterCount(input: AgnesFlashInput): number {
  return input.prompt.length;
}
