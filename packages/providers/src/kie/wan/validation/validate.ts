/**
 * KIE-006 — Wan 3.0 multimodal validation.
 *
 * Pure, synchronous, dependency-free. Runs BEFORE any provider call: the
 * acceptance contract is that an invalid request never reaches
 * `KieTaskClient.createTask`. Callers must invoke {@link validateWanRequest}
 * on the assembled request and only submit when `ok === true`.
 */

import {
  WAN_MAX_DURATION_SECONDS,
  WAN_MAX_PROMPT_CHARS,
  WAN_MAX_REFERENCE_AUDIO,
  WAN_MAX_REFERENCE_IMAGES,
  WAN_MAX_REFERENCE_VIDEOS,
  WAN_MIN_DURATION_SECONDS,
  WAN_SUPPORTED_RESOLUTIONS,
  type WanMultimodalRequest,
  type WanValidationResult,
  type WanViolation,
  type WanViolationCode,
} from "./types.js";

/** Check a reference URL is a non-empty string (http(s) URL or data URI). */
function isReferenceValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  // Accept absolute http(s) URLs and data URIs (profile layer may inline small
  // references); anything else is left to live provider verification, which
  // this module must not guess at.
  return /^https?:\/\//i.test(v) || /^data:/i.test(v);
}

/** Collect entries of a possibly-undefined reference array with their indexes. */
function refEntries(values: string[] | undefined): Array<[number, string]> {
  return (values ?? []).map((v, i) => [i, v] as [number, string]);
}

/** Validate one reference array; returns the count and any INVALID_REFERENCE violations. */
function validateReferenceArray(
  values: string[] | undefined,
  field: string,
  out: WanViolation[],
): number {
  const entries = refEntries(values);
  for (const [i, v] of entries) {
    if (!isReferenceValue(v)) {
      out.push({
        code: "INVALID_REFERENCE",
        field: `${field}[${i}]`,
        message: `${field}[${i}] must be a non-empty http(s) URL or data URI`,
      });
    }
  }
  return entries.length;
}

/**
 * Validate a Wan 3.0 generation request against the documented hard limits
 * and the first/last-frame vs multimodal mutual exclusion. Returns ALL
 * violations found, not just the first, so callers can fix in one pass.
 */
export function validateWanRequest(request: WanMultimodalRequest): WanValidationResult {
  const violations: WanViolation[] = [];

  // --- prompt -------------------------------------------------------------
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    violations.push({
      code: "MISSING_PROMPT",
      field: "prompt",
      message: "prompt is required and must be non-empty",
    });
  } else if (request.prompt.length > WAN_MAX_PROMPT_CHARS) {
    violations.push({
      code: "PROMPT_TOO_LONG",
      field: "prompt",
      message: `prompt is ${request.prompt.length} characters; Wan 3.0 accepts at most ${WAN_MAX_PROMPT_CHARS}`,
    });
  }

  // --- multimodal references ---------------------------------------------
  const imageCount = validateReferenceArray(request.referenceImages, "referenceImages", violations);
  if (imageCount > WAN_MAX_REFERENCE_IMAGES) {
    violations.push({
      code: "TOO_MANY_REFERENCE_IMAGES",
      field: "referenceImages",
      message: `${imageCount} reference images given; Wan 3.0 accepts at most ${WAN_MAX_REFERENCE_IMAGES}`,
    });
  }
  const videoCount = validateReferenceArray(request.referenceVideos, "referenceVideos", violations);
  if (videoCount > WAN_MAX_REFERENCE_VIDEOS) {
    violations.push({
      code: "TOO_MANY_REFERENCE_VIDEOS",
      field: "referenceVideos",
      message: `${videoCount} reference videos given; Wan 3.0 accepts at most ${WAN_MAX_REFERENCE_VIDEOS}`,
    });
  }
  const audioCount = validateReferenceArray(request.referenceAudio, "referenceAudio", violations);
  if (audioCount > WAN_MAX_REFERENCE_AUDIO) {
    violations.push({
      code: "TOO_MANY_REFERENCE_AUDIO",
      field: "referenceAudio",
      message: `${audioCount} reference audio clips given; Wan 3.0 accepts at most ${WAN_MAX_REFERENCE_AUDIO}`,
    });
  }

  // --- mode exclusivity ---------------------------------------------------
  // Multimodal references cannot combine with first/last-frame inputs.
  const hasFirstFrame = typeof request.firstFrameUrl === "string" && request.firstFrameUrl.trim().length > 0;
  const hasLastFrame = typeof request.lastFrameUrl === "string" && request.lastFrameUrl.trim().length > 0;
  const hasMultimodal = imageCount > 0 || videoCount > 0 || audioCount > 0;
  if (hasMultimodal && (hasFirstFrame || hasLastFrame)) {
    violations.push({
      code: "MODE_CONFLICT",
      field: "firstFrameUrl/lastFrameUrl",
      message:
        "multimodal references (referenceImages/referenceVideos/referenceAudio) cannot be combined with first/last-frame inputs; pick one mode",
    });
  }

  // --- first/last-frame values --------------------------------------------
  if (hasFirstFrame && !isReferenceValue(request.firstFrameUrl)) {
    violations.push({
      code: "INVALID_REFERENCE",
      field: "firstFrameUrl",
      message: "firstFrameUrl must be a non-empty http(s) URL or data URI",
    });
  }
  if (hasLastFrame && !isReferenceValue(request.lastFrameUrl)) {
    violations.push({
      code: "INVALID_REFERENCE",
      field: "lastFrameUrl",
      message: "lastFrameUrl must be a non-empty http(s) URL or data URI",
    });
  }

  // --- duration ------------------------------------------------------------
  if (request.durationSeconds !== undefined) {
    const d = request.durationSeconds;
    if (typeof d !== "number" || !Number.isFinite(d) || d < WAN_MIN_DURATION_SECONDS || d > WAN_MAX_DURATION_SECONDS) {
      violations.push({
        code: "INVALID_DURATION",
        field: "durationSeconds",
        message: `durationSeconds must be a finite number between ${WAN_MIN_DURATION_SECONDS} and ${WAN_MAX_DURATION_SECONDS}`,
      });
    }
  }

  // --- resolution -----------------------------------------------------------
  if (request.resolution !== undefined && !WAN_SUPPORTED_RESOLUTIONS.includes(request.resolution)) {
    violations.push({
      code: "INVALID_RESOLUTION",
      field: "resolution",
      message: `resolution must be one of ${WAN_SUPPORTED_RESOLUTIONS.join(", ")}`,
    });
  }

  if (violations.length === 0) {
    return { ok: true, request };
  }
  return { ok: false, violations };
}

/** True when a validation result can be submitted to the provider. */
export function isWanRequestValid(result: WanValidationResult): boolean {
  return result.ok;
}

/** Convenience predicate: would this request be rejected before the call? */
export function assertWanRequestValid(request: WanMultimodalRequest): void {
  const result = validateWanRequest(request);
  if (!result.ok) {
    const codes = result.violations.map((v) => v.code).join(", ") as WanViolationCode | string;
    throw new Error(`Wan request rejected before provider call (${codes})`);
  }
}