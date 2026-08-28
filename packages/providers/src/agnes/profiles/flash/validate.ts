/**
 * Agnes Video 2.5 Flash pre-submit validation (@mmcs/providers/agnes/profiles/flash).
 *
 * Task AGN-006. Enforces the VERIFIED limits from `capability.ts` exactly as
 * the live docs state them; every failure surfaces as HTTP-400-equivalent
 * context the adapter can report verbatim. UNKNOWN values (prompt hard max,
 * audio reference max) are never enforced — see `promptCeiling` below.
 */

import {
  AGNES_FLASH_ASPECT_RATIOS,
  AGNES_FLASH_LIMITS,
  AGNES_FLASH_MODEL,
  type AgnesFlashAspectRatio,
  type AgnesFlashMode,
} from "./capability.js";

/** A single validation failure. */
export interface AgnesFlashValidationError {
  /** Dotted path to the offending field (e.g. "input.images"). */
  field: string;
  message: string;
}

/** Result of validating a request against the live Flash schema. */
export interface AgnesFlashValidationResult {
  ok: boolean;
  /** Detected mode when ok, else undefined. */
  mode?: AgnesFlashMode;
  errors: AgnesFlashValidationError[];
}

/** Structured input for one Flash generation (camelCase; wire map below). */
export interface AgnesFlashInput {
  prompt: string;
  mode?: AgnesFlashMode;
  /** keyframe mode: first-frame image URL. */
  firstFrameUrl?: string;
  /** keyframe mode: last-frame image URL. */
  lastFrameUrl?: string;
  /** reference mode: image URLs. Max 5. */
  referenceImageUrls?: readonly string[];
  /** Reference audio URLs (common rules; max count UNKNOWN — not enforced). */
  referenceAudioUrls?: readonly string[];
  /** reference mode: NOT SUPPORTED on Flash — any non-empty array rejected. */
  referenceVideoUrls?: readonly string[];
  /** `"4"`–`"12"` (wire is a string; adapter converts). */
  seconds?: number;
  /** Fixed "720P" on Flash. */
  size?: string;
  aspectRatio?: AgnesFlashAspectRatio;
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

function urlError(field: string): AgnesFlashValidationError {
  return {
    field,
    message: "must be an https URL or an asset://{assetId} reference",
  };
}

function hasReferenceInputs(input: AgnesFlashInput): boolean {
  return (
    (input.referenceImageUrls !== undefined &&
      input.referenceImageUrls.length > 0) ||
    (input.referenceAudioUrls !== undefined &&
      input.referenceAudioUrls.length > 0) ||
    (input.referenceVideoUrls !== undefined &&
      input.referenceVideoUrls.length > 0)
  );
}

/**
 * Detect the single generation mode from the input. Text mode is explicit via
 * `input.mode`; otherwise keyframe wins over reference (matching the adapter
 * call sites). Returns undefined when nothing enables a mode.
 */
export function detectFlashMode(input: AgnesFlashInput): AgnesFlashMode | undefined {
  if (input.mode !== undefined) return input.mode;
  const hasFrame = input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined;
  if (hasFrame) return "keyframe";
  if (hasReferenceInputs(input)) return "reference";
  return "text";
}

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

/**
 * Validate one Flash request against the live schema. Never enforces a
 * prompt character ceiling — the live docs state none (UNKNOWN).
 */
export function validateAgnesFlashInput(
  input: AgnesFlashInput,
): AgnesFlashValidationResult {
  const errors: AgnesFlashValidationError[] = [];

  // --- prompt (required; NO character ceiling — UNKNOWN per live docs) ----
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    errors.push({ field: "input.prompt", message: "prompt is required" });
  }

  const mode = detectFlashMode(input);

  // --- length / size envelopes --------------------------------------------
  if (input.seconds !== undefined) {
    if (!isInteger(input.seconds)) {
      errors.push({
        field: "input.seconds",
        message: "seconds must be an integer number of seconds",
      });
    } else {
      const { min, max } = AGNES_FLASH_LIMITS.durationSeconds.value;
      if (input.seconds < min || input.seconds > max) {
        errors.push({
          field: "input.seconds",
          message: `seconds must be "${min}"–"${max}" (doc states a string; got ${input.seconds})`,
        });
      }
    }
  }
  if (input.size !== undefined && input.size !== "720P") {
    errors.push({
      field: "input.size",
      message: 'size must be "720P" — Flash is fixed to 720P, other values return HTTP 400 "size must be 720P"',
    });
  }
  if (
    input.aspectRatio !== undefined &&
    !AGNES_FLASH_ASPECT_RATIOS.includes(input.aspectRatio)
  ) {
    errors.push({
      field: "input.aspect_ratio",
      message: `aspect_ratio must be one of ${AGNES_FLASH_ASPECT_RATIOS.join(", ")}`,
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
  if (hasRefs) {
    for (const [field, url] of [
      ["input.images", input.referenceImageUrls],
      ["input.audios", input.referenceAudioUrls],
      ["input.videos", input.referenceVideoUrls],
    ] as const) {
      if (url !== undefined) {
        for (const u of url) {
          if (!isHttpUrl(u) && !isAssetRef(u)) {
            errors.push(urlError(field));
            break;
          }
        }
      }
    }
  }

  if (hasRefs && (hasFirst || hasLast)) {
    errors.push({
      field: "input",
      message:
        "mutually exclusive modes: reference inputs (images/audios/videos) cannot be combined with first_frame/last_frame",
    });
  }

  // --- Flash mode rules ------------------------------------------------------
  if (mode === "keyframe" && !hasFirst && !hasLast) {
    errors.push({
      field: "input",
      message: "keyframe mode requires at least one of first_frame or last_frame",
    });
  }
  if (mode === "reference" && !hasRefs) {
    errors.push({
      field: "input",
      message: "reference mode requires at least one non-empty images or audios array (videos not supported on Flash)",
    });
  }
  if (mode === "text" && (hasFirst || hasLast || hasRefs)) {
    errors.push({
      field: "input",
      message: "mode=text must not carry media fields (first_frame/last_frame/images/audios/videos)",
    });
  }

  // --- Flash-specific reference caps -----------------------------------------
  const imgMax = AGNES_FLASH_LIMITS.maxReferenceImages.value;
  if (
    input.referenceImageUrls !== undefined &&
    input.referenceImageUrls.length > imgMax
  ) {
    errors.push({
      field: "input.images",
      message: `at most ${imgMax} reference images (doc: "images length must not exceed 5")`,
    });
  }
  if (
    input.referenceVideoUrls !== undefined &&
    input.referenceVideoUrls.length > 0
  ) {
    errors.push({
      field: "input.videos",
      message: 'videos are not supported on Flash (HTTP 400 "videos is not supported")',
    });
  }
  // NOTE: referenceAudioUrls max count is UNKNOWN (common rules state none) —
  // deliberately not enforced. Prompt hard max is UNKNOWN — never enforced.

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
export function flashPromptCeiling(): {
  hardMaxCharacters: null;
  status: "UNKNOWN";
} {
  return {
    hardMaxCharacters: null,
    status: "UNKNOWN",
  };
}

/** The wire model field this validator guards. */
export function flashModelId(): typeof AGNES_FLASH_MODEL {
  return AGNES_FLASH_MODEL;
}
