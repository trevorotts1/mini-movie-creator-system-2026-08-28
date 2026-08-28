/**
 * AGN-008 — Agnes capability profiles for validation (video 2.5 Flash and
 * regular). Built from the CAP-002 seeds (packages/capability-registry
 * src/data/agnes.ts, verified against the live Agnes docs 2026-08-28) with
 * the two Agnes-specific facts the seed's generic shape cannot carry:
 * `referenceVideoSupported` (Flash false / regular true) and the verified
 * resolution lists.
 *
 * The provider-agnostic {@link AgnesVideoRequestShape} here is validated
 * against these profiles before the adapter (AGN-004 submit layer) maps it
 * onto the exact Agnes request body and calls the provider.
 */

import type { AgnesValidationProfile, AgnesVideoMode } from "./types.js";

/** Docs verified 2026-08-28; see docs/provider-capabilities/agnes.md. */
const VERIFIED_ON = "2026-08-28";

/**
 * Agnes Video 2.5 Flash — `agnes-video-2.5-flash`.
 * size fixed "720P" (else HTTP 400); images max 5 (HTTP 400); videos never
 * supported (HTTP 400 "videos is not supported"); keyframe first/last/both
 * supported; audios allowed, max count not stated → UNKNOWN.
 * Prompt hard max NOT stated anywhere → UNKNOWN (never enforced, never guessed).
 */
export const AGNES_VIDEO_2_5_FLASH_VALIDATION_PROFILE: AgnesValidationProfile =
  Object.freeze({
    modelId: "agnes-video-2.5-flash",
    prompt: { hardMaxCharacters: null },
    references: {
      maxImages: 5,
      maxVideos: null,
      maxAudio: null,
      firstFrame: true,
      lastFrame: true,
      firstLastFrame: true,
      multimodalReferences: true,
      referenceVideoSupported: false,
    },
    output: {
      minDurationSeconds: 4,
      maxDurationSeconds: 12,
      resolutions: ["720P"],
    },
    /** Provenance for audit trails; not consumed by the validator logic. */
    verifiedOn: VERIFIED_ON,
    sourceUrls: [
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash",
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
      "https://wiki.agnes-ai.com/en/docs/pricing",
    ],
  } as AgnesValidationProfile);

/**
 * Agnes Video 2.5 regular — `agnes-video-2.5`.
 * sizes 720P/960P/2K; images/audios/videos accepted in reference mode with
 * counts NOT stated → UNKNOWN (never enforced); keyframe first/last/both
 * supported. Prompt hard max NOT stated → UNKNOWN.
 */
export const AGNES_VIDEO_2_5_VALIDATION_PROFILE: AgnesValidationProfile =
  Object.freeze({
    modelId: "agnes-video-2.5",
    prompt: { hardMaxCharacters: null },
    references: {
      maxImages: null,
      maxVideos: null,
      maxAudio: null,
      firstFrame: true,
      lastFrame: true,
      firstLastFrame: true,
      multimodalReferences: true,
      referenceVideoSupported: true,
    },
    output: {
      minDurationSeconds: 4,
      maxDurationSeconds: 12,
      resolutions: ["720P", "960P", "2K"],
    },
    verifiedOn: VERIFIED_ON,
    sourceUrls: [
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
      "https://wiki.agnes-ai.com/en/docs/pricing",
    ],
  } as AgnesValidationProfile);

/** Every Agnes video validation profile, keyed by model id. */
export const AGNES_VIDEO_VALIDATION_PROFILES: Readonly<
  Record<string, AgnesValidationProfile>
> = Object.freeze({
  "agnes-video-2.5-flash": AGNES_VIDEO_2_5_FLASH_VALIDATION_PROFILE,
  "agnes-video-2.5": AGNES_VIDEO_2_5_VALIDATION_PROFILE,
});

/** Resolve the validation profile for a model id; undefined when unseeded. */
export function getAgnesValidationProfile(
  modelId: string,
): AgnesValidationProfile | undefined {
  return AGNES_VIDEO_VALIDATION_PROFILES[modelId];
}

/**
 * Classify the effective mode of a request shape from its fields alone
 * (explicit `mode` ignored — see {@link inferAgnesMode} for the
 * mode-vs-fields agreement check). Deterministic precedence: keyframe fields
 * win over reference fields, so a request with both classifies as keyframe
 * and the mode-conflict rule reports the reference fields.
 */
export function fieldsToMode(shape: {
  prompt?: unknown;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: readonly string[];
  referenceAudioUrls?: readonly string[];
  referenceVideos?: readonly unknown[];
}): AgnesVideoMode | null {
  const hasFrame =
    isPresent(shape.firstFrameUrl) || isPresent(shape.lastFrameUrl);
  const hasReferenceMedia =
    hasEntries(shape.referenceImageUrls) ||
    hasEntries(shape.referenceAudioUrls) ||
    hasEntries(shape.referenceVideos);
  if (hasFrame && hasReferenceMedia) return null; // fields conflict
  if (hasFrame) return "keyframe";
  if (hasReferenceMedia) return "reference";
  return "text";
}

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEntries(value: readonly unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}