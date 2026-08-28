/**
 * AGN-008 — Agnes request-shape validator.
 *
 * Validates the provider-agnostic request shape against the model's
 * capability profile BEFORE any provider call (runbook §16 pre-request
 * validation; §25 acceptance for this task). Pure — no I/O, no fetch.
 *
 * Rules per effective mode (verified against the live Agnes docs
 * 2026-08-28, docs/provider-capabilities/agnes.md):
 *   - exactly one of `text` / `keyframe` / `reference` applies;
 *   - `keyframe`: ≥1 of firstFrameUrl/lastFrameUrl; images/audios/videos
 *     disallowed;
 *   - `reference`: ≥1 non-empty media array; firstFrameUrl/lastFrameUrl
 *     disallowed;
 *   - `text`: no media fields at all;
 *   - an explicit `mode` that disagrees with the fields is a conflict;
 *   - profile capability gates: firstFrame/lastFrame/firstLastFrame/
 *     multimodalReferences/referenceVideoSupported flags; nullable count
 *     limits (UNKNOWN) never enforced; verified resolution list checked
 *     when present.
 */

import type {
  AgnesReferenceVideo,
  AgnesValidationIssue,
  AgnesValidationIssueCode,
  AgnesValidationProfile,
  AgnesValidationResult,
  AgnesVideoMode,
  AgnesVideoRequestShape,
} from "./types.js";
import { fieldsToMode } from "./profiles.js";

/**
 * Validate an Agnes video request shape against its capability profile.
 * Returns every issue found; an empty list means the request may proceed to
 * the adapter's payload mapping and the provider call.
 */
export function validateAgnesRequest(
  profile: AgnesValidationProfile,
  shape: AgnesVideoRequestShape,
): AgnesValidationResult {
  const issues: AgnesValidationIssue[] = [];

  // --- prompt (always required; hard max enforced only when VERIFIED) ------
  if (typeof shape.prompt !== "string" || shape.prompt.trim().length === 0) {
    issues.push({
      field: "prompt",
      code: "MISSING_PROMPT",
      message: "prompt is required for every Agnes mode",
    });
  } else {
    const hardMax = profile.prompt?.hardMaxCharacters ?? null;
    if (hardMax !== null) {
      if (
        typeof hardMax !== "number" ||
        !Number.isInteger(hardMax) ||
        hardMax < 0
      ) {
        issues.push({
          field: "profile",
          code: "INVALID_PROFILE_LIMIT",
          message: `capability profile prompt.hardMaxCharacters must be a non-negative integer or null (got ${String(hardMax)})`,
        });
      } else if (shape.prompt.length > hardMax) {
        issues.push({
          field: "prompt",
          code: "PROMPT_TOO_LONG",
          message: `prompt exceeds the documented maximum of ${hardMax} characters (got ${shape.prompt.length})`,
        });
      }
    }
    // null hardMax = UNKNOWN → no prompt-length check. Agnes' ceiling is
    // undocumented; never enforce another model's limit in its place.
  }

  // --- fields present? ------------------------------------------------------
  const firstRaw = isSet(shape.firstFrameUrl);
  const lastRaw = isSet(shape.lastFrameUrl);
  const firstPresent = isPresent(shape.firstFrameUrl);
  const lastPresent = isPresent(shape.lastFrameUrl);
  const imagesPresent = hasEntries(shape.referenceImageUrls);
  const audiosPresent = hasEntries(shape.referenceAudioUrls);
  const videosPresent = hasEntries(shape.referenceVideos);
  const anyFrame = firstPresent || lastPresent;
  const anyReferenceMedia = imagesPresent || audiosPresent || videosPresent;

  // --- mode resolution ------------------------------------------------------
  const fieldsMode = fieldsToMode(shape);
  const explicitMode =
    shape.mode === "text" || shape.mode === "keyframe" || shape.mode === "reference"
      ? shape.mode
      : null;

  if (
    shape.mode !== undefined &&
    shape.mode !== "text" &&
    shape.mode !== "keyframe" &&
    shape.mode !== "reference"
  ) {
    issues.push({
      field: "mode",
      code: "UNKNOWN_MODE",
      message: `mode must be one of "text", "keyframe", "reference" (got ${JSON.stringify(shape.mode)})`,
    });
  }

  if (fieldsMode === null) {
    issues.push({
      field: "mode",
      code: "MODE_FIELDS_CONFLICT",
      message:
        "request carries both frame fields (firstFrameUrl/lastFrameUrl) and reference media (images/audios/videos) — Agnes accepts exactly one generation mode; remove one side",
    });
  } else if (explicitMode !== null && explicitMode !== fieldsMode) {
    issues.push({
      field: "mode",
      code: "MODE_FIELDS_CONFLICT",
      message: `explicit mode "${explicitMode}" disagrees with the request fields, which resolve to "${fieldsMode}" — set mode to match the fields or omit it`,
    });
  }

  // Per-mode field rules run against the resolved mode: the explicit mode when
  // given (so its own requirements — e.g. "keyframe needs a frame" — are
  // reported specifically), otherwise the mode the fields resolve to; null
  // when fields conflict with no explicit mode (the conflict issue above covers
  // it — no single Agnes mode exists for the payload).
  const mode: AgnesVideoMode | null = explicitMode ?? fieldsMode;

  // --- per-mode field rules (only when a single mode exists) ----------------
  if (mode === "text") {
    if (anyFrame || anyReferenceMedia) {
      issues.push({
        field: "mode",
        code: "TEXT_MODE_MEDIA_FIELDS",
        message:
          "text mode allows no media fields (firstFrameUrl/lastFrameUrl/referenceImageUrls/referenceAudioUrls/referenceVideos)",
      });
    }
  } else if (mode === "keyframe") {
    if (!firstPresent && !lastPresent) {
      issues.push({
        field: "firstFrameUrl",
        code: "KEYFRAME_REQUIRES_FRAME",
        message:
          "keyframe mode requires at least one of firstFrameUrl/lastFrameUrl",
      });
    }
    if (anyReferenceMedia) {
      issues.push({
        field: "mode",
        code: "KEYFRAME_DISALLOWS_REFERENCE_MEDIA",
        message:
          "keyframe mode disallows reference media (referenceImageUrls/referenceAudioUrls/referenceVideos) — Agnes keyframe and reference are separate modes",
      });
    }
  } else if (mode === "reference") {
    if (!anyReferenceMedia) {
      issues.push({
        field: "referenceImageUrls",
        code: "REFERENCE_REQUIRES_MEDIA",
        message:
          "reference mode requires at least one non-empty of referenceImageUrls/referenceAudioUrls/referenceVideos",
      });
    }
    if (anyFrame) {
      issues.push({
        field: "mode",
        code: "REFERENCE_DISALLOWS_FRAME_FIELDS",
        message:
          "reference mode disallows firstFrameUrl/lastFrameUrl — Agnes reference and keyframe are separate modes",
      });
    }
  }
  // mode === null: the mode-level issue is already reported above.

  // --- per-model capability flags -------------------------------------------
  if (firstRaw && typeof shape.firstFrameUrl !== "string") {
    issues.push({
      field: "firstFrameUrl",
      code: "INVALID_FRAME_ENTRY",
      message: "firstFrameUrl must be a non-empty URL string when present",
    });
  }
  if (lastRaw && typeof shape.lastFrameUrl !== "string") {
    issues.push({
      field: "lastFrameUrl",
      code: "INVALID_FRAME_ENTRY",
      message: "lastFrameUrl must be a non-empty URL string when present",
    });
  }
  if (firstPresent && !profile.references?.firstFrame) {
    issues.push({
      field: "firstFrameUrl",
      code: "FIRST_FRAME_NOT_SUPPORTED",
      message: `${profile.modelId} does not support first-frame input`,
    });
  }
  if (lastPresent && !profile.references?.lastFrame) {
    issues.push({
      field: "lastFrameUrl",
      code: "LAST_FRAME_NOT_SUPPORTED",
      message: `${profile.modelId} does not support last-frame input`,
    });
  }
  if (firstPresent && lastPresent && !profile.references?.firstLastFrame) {
    issues.push({
      field: "mode",
      code: "FIRST_LAST_FRAME_COMBINATION_NOT_SUPPORTED",
      message: `${profile.modelId} does not support the first+last-frame combination`,
    });
  }
  if (anyReferenceMedia && !profile.references?.multimodalReferences) {
    issues.push({
      field: "mode",
      code: "MULTIMODAL_REFERENCES_NOT_SUPPORTED",
      message: `${profile.modelId} does not support multimodal reference inputs`,
    });
  }
  if (videosPresent && !profile.references?.referenceVideoSupported) {
    issues.push({
      field: "referenceVideos",
      code: "REFERENCE_VIDEOS_NOT_SUPPORTED",
      message: `${profile.modelId} rejects a non-empty videos array (HTTP 400 "videos is not supported")`,
    });
  }

  // --- reference counts (VERIFIED limits only; null UNKNOWN never enforced) --
  const references = profile.references ?? {};
  checkCountLimit(
    references.maxImages,
    imagesPresent ? shape.referenceImageUrls!.length : 0,
    "referenceImageUrls",
    "images",
    issues,
  );
  checkCountLimit(
    references.maxVideos,
    videosPresent ? shape.referenceVideos!.length : 0,
    "referenceVideos",
    "videos",
    issues,
  );
  checkCountLimit(
    references.maxAudio,
    audiosPresent ? shape.referenceAudioUrls!.length : 0,
    "referenceAudioUrls",
    "audios",
    issues,
  );

  // --- reference entry shapes -------------------------------------------------
  if (shape.referenceImageUrls !== undefined && !Array.isArray(shape.referenceImageUrls)) {
    issues.push({
      field: "referenceImageUrls",
      code: "INVALID_REFERENCE_ENTRY",
      message: "referenceImageUrls must be an array of URL strings",
    });
  } else {
    shape.referenceImageUrls?.forEach((url, index) => {
      if (typeof url !== "string" || url.trim().length === 0) {
        issues.push({
          field: `referenceImageUrls[${index}]`,
          code: "INVALID_REFERENCE_ENTRY",
          message: "reference image entries must be non-empty URL strings",
        });
      }
    });
  }
  if (shape.referenceAudioUrls !== undefined && !Array.isArray(shape.referenceAudioUrls)) {
    issues.push({
      field: "referenceAudioUrls",
      code: "INVALID_REFERENCE_ENTRY",
      message: "referenceAudioUrls must be an array of URL strings",
    });
  } else {
    shape.referenceAudioUrls?.forEach((url, index) => {
      if (typeof url !== "string" || url.trim().length === 0) {
        issues.push({
          field: `referenceAudioUrls[${index}]`,
          code: "INVALID_REFERENCE_ENTRY",
          message: "reference audio entries must be non-empty URL strings",
        });
      }
    });
  }
  if (shape.referenceVideos !== undefined && !Array.isArray(shape.referenceVideos)) {
    issues.push({
      field: "referenceVideos",
      code: "INVALID_REFERENCE_VIDEO_ENTRY",
      message: "referenceVideos must be an array of video-entry objects",
    });
  } else {
    shape.referenceVideos?.forEach((video, index) => {
      const entry = video as Partial<AgnesReferenceVideo> | null | undefined;
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.url !== "string" ||
        entry.url.trim().length === 0
      ) {
        issues.push({
          field: `referenceVideos[${index}]`,
          code: "INVALID_REFERENCE_VIDEO_ENTRY",
          message:
            "reference video entries must be objects with a non-empty url (startSeconds/requireAudio optional)",
        });
        return;
      }
      if (
        entry.startSeconds !== undefined &&
        (typeof entry.startSeconds !== "number" || !Number.isFinite(entry.startSeconds))
      ) {
        issues.push({
          field: `referenceVideos[${index}].startSeconds`,
          code: "INVALID_REFERENCE_VIDEO_ENTRY",
          message: "reference video startSeconds must be a finite number",
        });
      }
      if (
        entry.requireAudio !== undefined &&
        typeof entry.requireAudio !== "boolean"
      ) {
        issues.push({
          field: `referenceVideos[${index}].requireAudio`,
          code: "INVALID_REFERENCE_VIDEO_ENTRY",
          message: "reference video requireAudio must be a boolean",
        });
      }
    });
  }

  // --- duration ---------------------------------------------------------------
  if (shape.seconds !== undefined) {
    let numeric: number | null = null;
    if (typeof shape.seconds === "number") {
      // Provider takes whole-second strings ("4"–"12"); reject NaN and
      // non-integer numbers instead of forwarding them as "NaN"/"4.5".
      if (!Number.isFinite(shape.seconds) || !Number.isInteger(shape.seconds)) {
        numeric = null;
      } else {
        numeric = shape.seconds;
      }
    } else if (
      typeof shape.seconds === "string" &&
      /^[0-9]+$/.test(shape.seconds.trim())
    ) {
      numeric = Number.parseInt(shape.seconds.trim(), 10);
    }
    if (numeric === null) {
      issues.push({
        field: "seconds",
        code: "INVALID_SECONDS",
        message: `seconds must be a number or a numeric string (got ${JSON.stringify(shape.seconds)})`,
      });
    } else {
      const min = profile.output?.minDurationSeconds ?? null;
      const max = profile.output?.maxDurationSeconds ?? null;
      if (
        (min !== null && numeric < min) ||
        (max !== null && numeric > max)
      ) {
        issues.push({
          field: "seconds",
          code: "INVALID_SECONDS",
          message: `seconds must be ${min}-${max} for ${profile.modelId} (got ${numeric})`,
        });
      }
    }
  }

  // --- size ---------------------------------------------------------------------
  const resolutions = profile.output?.resolutions ?? null;
  if (
    shape.size !== undefined &&
    resolutions !== null &&
    !resolutions.includes(shape.size)
  ) {
    issues.push({
      field: "size",
      code: "INVALID_SIZE",
      message: `size must be ${resolutions.join(" | ")} for ${profile.modelId} (got ${JSON.stringify(shape.size)})`,
    });
  }

  return { ok: issues.length === 0, mode, issues };
}

/** Shared per-array limit check; null limit (UNKNOWN) never enforced. */
function checkCountLimit(
  limit: number | null | undefined,
  count: number,
  field: string,
  providerField: string,
  issues: AgnesValidationIssue[],
): void {
  if (limit === null || limit === undefined) return; // UNKNOWN — never enforced
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
    issues.push({
      field: "profile",
      code: "INVALID_PROFILE_LIMIT",
      message: `capability profile ${providerField} limit must be a non-negative integer or null (got ${String(limit)})`,
    });
    return;
  }
  if (count > limit) {
    issues.push({
      field,
      code:
        providerField === "images"
          ? ("TOO_MANY_REFERENCE_IMAGES" as AgnesValidationIssueCode)
          : providerField === "videos"
            ? ("TOO_MANY_REFERENCE_VIDEOS" as AgnesValidationIssueCode)
            : ("TOO_MANY_REFERENCE_AUDIOS" as AgnesValidationIssueCode),
      message: `${field} allows at most ${limit} reference(s) for this model (HTTP 400 "${providerField} length must not exceed ${limit}"); got ${count}`,
    });
  }
}

/** Thrown by {@link assertAgnesRequest} on any pre-flight failure. */
export class AgnesRequestValidationError extends Error {
  readonly issues: readonly AgnesValidationIssue[];
  constructor(issues: readonly AgnesValidationIssue[]) {
    super(
      `Agnes request failed pre-flight validation (${issues.length} issue(s)): ${issues
        .map((issue) => `[${issue.code}] ${issue.field}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "AgnesRequestValidationError";
    this.issues = issues;
  }
}

/**
 * Validate or throw. The adapter calls this right before payload submission;
 * callers wanting soft handling use {@link validateAgnesRequest} directly.
 * Returns the resolved effective mode (never null when this returns).
 */
export function assertAgnesRequest(
  profile: AgnesValidationProfile,
  shape: AgnesVideoRequestShape,
): AgnesVideoMode {
  const result = validateAgnesRequest(profile, shape);
  if (!result.ok || result.mode === null) {
    throw new AgnesRequestValidationError(result.issues);
  }
  return result.mode;
}

/** True when the shape carries any media input field (frame or reference). */
export function hasAnyMediaField(shape: AgnesVideoRequestShape): boolean {
  return (
    isPresent(shape.firstFrameUrl) ||
    isPresent(shape.lastFrameUrl) ||
    hasEntries(shape.referenceImageUrls) ||
    hasEntries(shape.referenceAudioUrls) ||
    hasEntries(shape.referenceVideos)
  );
}

/**
 * The single effective mode of a request shape, or null when the fields
 * conflict (both a frame field and reference media present). The explicit
 * `mode` field is NOT consulted — see {@link validateAgnesRequest} for the
 * full agreement check.
 */
export function effectiveMode(
  shape: AgnesVideoRequestShape,
): AgnesVideoMode | null {
  return fieldsToMode(shape);
}

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when the field is set (including wrong types and empty strings). */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasEntries(value: readonly unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}