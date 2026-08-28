/**
 * Agnes Video 2.5 regular pre-submit validation (@mmcs/providers/agnes/profiles/regular).
 *
 * Task AGN-007. Enforces the VERIFIED limits from `capability.ts` exactly as
 * the live docs state them; every failure surfaces as HTTP-400-equivalent
 * context the adapter can report verbatim. UNKNOWN values (prompt hard max,
 * image/video/audio reference max counts) are never enforced — see
 * `regularPromptCeiling` below. Unlike Flash (AGN-006), reference videos are
 * SUPPORTED on regular, so a non-empty videos[] array is valid here.
 */

import {
  AGNES_REGULAR_ASPECT_RATIOS,
  AGNES_REGULAR_LIMITS,
  AGNES_REGULAR_SIZES,
  AGNES_REGULAR_MODEL,
  type AgnesRegularAspectRatio,
  type AgnesRegularMode,
  type AgnesRegularSize,
} from "./capability.js";

/** A single validation failure. */
export interface AgnesRegularValidationError {
  /** Dotted path to the offending field (e.g. "input.images"). */
  field: string;
  message: string;
}

/** Result of validating a request against the live regular schema. */
export interface AgnesRegularValidationResult {
  ok: boolean;
  /** Detected mode when ok, else undefined. */
  mode?: AgnesRegularMode;
  errors: AgnesRegularValidationError[];
}

/** One reference-video entry (regular only; wire shape videos[]). */
export interface AgnesRegularReferenceVideo {
  /** Required by the provider. */
  url: string;
  /** Seconds into the video the reference starts. Default 0. */
  startSeconds?: number;
  /** Whether the reference clip's audio is used. Default false. */
  requireAudio?: boolean;
}

/** Structured input for one regular generation (camelCase; wire map below). */
export interface AgnesRegularInput {
  prompt: string;
  mode?: AgnesRegularMode;
  /** keyframe mode: first-frame image URL. */
  firstFrameUrl?: string;
  /** keyframe mode: last-frame image URL. */
  lastFrameUrl?: string;
  /** reference mode: image URLs. Hard cap UNKNOWN — not enforced. */
  referenceImageUrls?: readonly string[];
  /** Reference audio URLs (max count UNKNOWN — not enforced). */
  referenceAudioUrls?: readonly string[];
  /** Reference video clips — SUPPORTED on regular (unlike Flash). */
  referenceVideos?: readonly AgnesRegularReferenceVideo[];
  /** `"4"`–`"12"` (wire is a string; adapter converts). */
  seconds?: number;
  /** "720P" | "960P" | "2K" (regular accepts all three tiers). */
  size?: AgnesRegularSize;
  aspectRatio?: AgnesRegularAspectRatio;
  /** Integer seed. */
  seed?: number;
}

const ASSET_SCHEME = /^asset:\/\/asset-[\w-]+$/;

function isAssetRef(url: string): boolean {
  return ASSET_SCHEME.test(url);
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function urlError(field: string): AgnesRegularValidationError {
  return {
    field,
    message: "must be an https URL or an asset://{assetId} reference",
  };
}

function hasReferenceInputs(input: AgnesRegularInput): boolean {
  return (
    (input.referenceImageUrls !== undefined &&
      input.referenceImageUrls.length > 0) ||
    (input.referenceAudioUrls !== undefined &&
      input.referenceAudioUrls.length > 0) ||
    (input.referenceVideos !== undefined && input.referenceVideos.length > 0)
  );
}

/**
 * Detect the single generation mode from the input. Text mode is explicit via
 * `input.mode`; otherwise keyframe wins over reference (matching the adapter
 * call sites). Returns undefined when nothing enables a mode.
 */
export function detectRegularMode(
  input: AgnesRegularInput,
): AgnesRegularMode | undefined {
  if (input.mode !== undefined) return input.mode;
  const hasFrame =
    input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined;
  if (hasFrame) return "keyframe";
  if (hasReferenceInputs(input)) return "reference";
  return "text";
}

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

/** Validate one videos[] entry's shape (url required; numbers numeric). */
function validateReferenceVideo(
  video: AgnesRegularReferenceVideo,
  index: number,
  errors: AgnesRegularValidationError[],
): void {
  const field = `input.videos[${index}]`;
  if (typeof video !== "object" || video === null || typeof video.url !== "string") {
    errors.push({
      field,
      message: "each videos[] entry requires a url string",
    });
    return;
  }
  if (!isHttpUrl(video.url) && !isAssetRef(video.url)) {
    errors.push({ ...urlError(`${field}.url`), field: `${field}.url` });
  }
  if (
    video.startSeconds !== undefined &&
    (typeof video.startSeconds !== "number" || video.startSeconds < 0)
  ) {
    errors.push({
      field: `${field}.start_seconds`,
      message: "start_seconds must be a non-negative number",
    });
  }
  if (
    video.requireAudio !== undefined &&
    typeof video.requireAudio !== "boolean"
  ) {
    errors.push({
      field: `${field}.require_audio`,
      message: "require_audio must be a boolean",
    });
  }
}

/**
 * Validate one regular request against the live schema. Never enforces a
 * prompt character ceiling — the live docs state none (UNKNOWN). Never
 * enforces image/video/audio reference max counts — UNKNOWN on regular.
 */
export function validateAgnesRegularInput(
  input: AgnesRegularInput,
): AgnesRegularValidationResult {
  const errors: AgnesRegularValidationError[] = [];

  // --- prompt (required; NO character ceiling — UNKNOWN per live docs) ----
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    errors.push({ field: "input.prompt", message: "prompt is required" });
  }

  const mode = detectRegularMode(input);

  // --- length / size envelopes --------------------------------------------
  if (input.seconds !== undefined) {
    if (!isInteger(input.seconds)) {
      errors.push({
        field: "input.seconds",
        message: "seconds must be an integer number of seconds",
      });
    } else {
      const { min, max } = AGNES_REGULAR_LIMITS.durationSeconds.value;
      if (input.seconds < min || input.seconds > max) {
        errors.push({
          field: "input.seconds",
          message: `seconds must be "${min}"–"${max}" (doc states a string; got ${input.seconds})`,
        });
      }
    }
  }
  if (input.size !== undefined && !AGNES_REGULAR_SIZES.includes(input.size)) {
    errors.push({
      field: "input.size",
      message: `size must be one of ${AGNES_REGULAR_SIZES.join(", ")} (WIDTHxHEIGHT and auto are rejected with HTTP 400)`,
    });
  }
  if (
    input.aspectRatio !== undefined &&
    !AGNES_REGULAR_ASPECT_RATIOS.includes(input.aspectRatio)
  ) {
    errors.push({
      field: "input.aspect_ratio",
      message: `aspect_ratio must be one of ${AGNES_REGULAR_ASPECT_RATIOS.join(", ")}`,
    });
  }

  // --- mode exclusivity (spec §26.3: never combine modes) -------------------
  const hasFirst = input.firstFrameUrl !== undefined;
  const hasLast = input.lastFrameUrl !== undefined;
  const hasRefs = hasReferenceInputs(input);

  if (hasFirst || hasLast) {
    for (const [field, url] of [
      ["input.first_frame", input.firstFrameUrl],
      ["input.last_frame", input.lastFrameUrl],
    ] as const) {
      if (url !== undefined && !isHttpUrl(url) && !isAssetRef(url)) {
        errors.push(urlError(field));
      }
    }
  }
  if (input.referenceImageUrls !== undefined) {
    for (const u of input.referenceImageUrls) {
      if (!isHttpUrl(u) && !isAssetRef(u)) {
        errors.push(urlError("input.images"));
        break;
      }
    }
  }
  if (input.referenceAudioUrls !== undefined) {
    for (const u of input.referenceAudioUrls) {
      if (!isHttpUrl(u) && !isAssetRef(u)) {
        errors.push(urlError("input.audios"));
        break;
      }
    }
  }
  if (input.referenceVideos !== undefined) {
    for (let i = 0; i < input.referenceVideos.length; i++) {
      const video = input.referenceVideos[i];
      if (video !== undefined) validateReferenceVideo(video, i, errors);
    }
  }

  if (hasRefs && (hasFirst || hasLast)) {
    errors.push({
      field: "input",
      message:
        "mutually exclusive modes: reference inputs (images/audios/videos) cannot be combined with first_frame/last_frame",
    });
  }

  // --- regular mode rules ------------------------------------------------------
  if (mode === "keyframe" && !hasFirst && !hasLast) {
    errors.push({
      field: "input",
      message: "keyframe mode requires at least one of first_frame or last_frame",
    });
  }
  if (mode === "reference" && !hasRefs) {
    errors.push({
      field: "input",
      message:
        "reference mode requires at least one non-empty images/audios/videos array",
    });
  }
  if (mode === "text" && (hasFirst || hasLast || hasRefs)) {
    errors.push({
      field: "input",
      message:
        "mode=text must not carry media fields (first_frame/last_frame/images/audios/videos)",
    });
  }

  // NOTE: no reference-image count enforcement — the hard cap is UNKNOWN on
  // regular (the 5 is the free-allowance billing rule, not a cap). No
  // video/audio count enforcement — UNKNOWN. Prompt hard max UNKNOWN — never
  // enforced. See AGNES_REGULAR_LIMITS notes.

  // --- seed ---------------------------------------------------------------------
  if (input.seed !== undefined) {
    if (!isInteger(input.seed)) {
      errors.push({
        field: "input.seed",
        message: "seed must be an integer",
      });
    }
  }

  const ok = errors.length === 0;
  return { ok, mode: ok ? mode : undefined, errors };
}

/**
 * Reference: the character ceiling UNKNOWN discipline — exposed so downstream
 * code (prompt budget manager) can ask and never guess.
 */
export function regularPromptCeiling(): {
  hardMaxCharacters: null;
  status: "UNKNOWN";
} {
  return {
    hardMaxCharacters: null,
    status: "UNKNOWN",
  };
}

/** Free-allowance billing facts for cost estimation (NOT a hard cap). */
export function regularImageAllowance(): {
  freeAllowance: number;
  excessUsdPerImage: number;
} {
  return {
    freeAllowance: AGNES_REGULAR_LIMITS.freeImageAllowance.value,
    excessUsdPerImage: AGNES_REGULAR_LIMITS.excessInputImageUsd.value,
  };
}

/** The wire model field this validator guards. */
export function regularModelId(): typeof AGNES_REGULAR_MODEL {
  return AGNES_REGULAR_MODEL;
}
