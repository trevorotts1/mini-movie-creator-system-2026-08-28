/**
 * Wan 3.0 pre-submit validation (KIE-005) + multimodal mode validation
 * (KIE-006 scope, same module — one adapter, one validator).
 *
 * Contract: EVERY check runs BEFORE a provider call (runbook §16/§25 — reject
 * over-limit prompts and over-count references before spending money). A
 * validation failure must never reach the wire.
 */
import { getWanProfile, type WanCapability, type WanModelId } from "./capability.js";
import type { WanMode, WanVideoInput } from "./types.js";

/** One validation failure. `field` is stable/machine-readable. */
export interface WanValidationError {
  field: string;
  message: string;
  /** Hard limit the input violated (when numeric and known). */
  limit?: number;
  actual?: number;
}

/** Thrown by validateWanInput; carries every failure found in one pass. */
export class WanValidationErrorList extends Error {
  readonly errors: WanValidationError[];
  constructor(errors: WanValidationError[]) {
    super(
      `Wan 3.0 input rejected (${errors.length} problem${errors.length === 1 ? "" : "s"}): ${errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ")}`,
    );
    this.name = "WanValidationErrorList";
    this.errors = errors;
  }
}

/**
 * Caller-declared durations of the provided reference-video clips (seconds).
 * Needed for the verified limit/billing rule: input video duration + output
 * duration ≤ 30. Optional — when absent, the cross-check is skipped.
 */
export interface WanValidationContext {
  /** Sum of the provided reference-video clip durations, in seconds. */
  referenceVideoSeconds?: number;
}

/** Classify the request into its generation mode. */
export function detectWanMode(input: WanVideoInput): WanMode {
  const hasFirst = Boolean(input.firstFrameUrl);
  const hasLast = Boolean(input.lastFrameUrl);
  const hasRefs =
    hasAny(input.referenceImageUrls) ||
    hasAny(input.referenceVideoUrls) ||
    hasAny(input.referenceAudioUrls);
  if (hasAny(input.referenceFileUrls)) return "file_to_video";
  if (hasAny(input.referenceLinkUrls)) return "link_to_video";
  if (hasFirst && hasLast) return "first_last_frame";
  if (hasFirst || hasLast) return "first_frame";
  if (hasRefs) return "multimodal_reference";
  return "text_to_video";
}

function hasAny(list: string[] | undefined): boolean {
  return Array.isArray(list) && list.length > 0;
}

const URL_FIELDS: ReadonlyArray<{ key: keyof WanVideoInput; label: string; max: (p: WanCapability) => number }> = [
  { key: "firstFrameUrl", label: "first_frame_url", max: () => 1 },
  { key: "lastFrameUrl", label: "last_frame_url", max: () => 1 },
  { key: "referenceImageUrls", label: "reference_image_urls", max: (p) => p.references.maxImages },
  { key: "referenceVideoUrls", label: "reference_video_urls", max: (p) => p.references.maxVideos },
  { key: "referenceAudioUrls", label: "reference_audio_urls", max: (p) => p.references.maxAudio },
  { key: "referenceFileUrls", label: "reference_file_urls", max: (p) => p.references.maxFiles },
  { key: "referenceLinkUrls", label: "reference_link_urls", max: (p) => p.references.maxLinks },
];

/**
 * Validate a Wan 3.0 input against its verified capability profile.
 * Throws {@link WanValidationErrorList} listing ALL problems found (not
 * first-fail) so callers can repair in one round. Returns the detected mode.
 */
export function validateWanInput(
  input: WanVideoInput,
  model: WanModelId = "wan/3-0-video",
  context: WanValidationContext = {},
): { mode: WanMode; profile: WanCapability } {
  const profile = getWanProfile(model);
  const errors: WanValidationError[] = [];

  // ---- prompt -----------------------------------------------------------
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const promptChars = [...prompt].length; // code points, not UTF-16 units
  if (promptChars > profile.prompt.hardMaxCharacters) {
    errors.push({
      field: "prompt",
      message: `prompt exceeds the hard maximum of ${profile.prompt.hardMaxCharacters} characters (server would silently truncate; MMCS rejects before submit)`,
      limit: profile.prompt.hardMaxCharacters,
      actual: promptChars,
    });
  }

  // ---- URL fields: shape + counts ----------------------------------------
  for (const { key, label, max } of URL_FIELDS) {
    const value = input[key] as string | string[] | undefined;
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (!isHttpUrl(value)) {
        errors.push({ field: label, message: "must be an http(s) URL" });
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((u) => typeof u !== "string" || !isHttpUrl(u))) {
        errors.push({ field: label, message: "every entry must be an http(s) URL string" });
      }
      const maxCount = max(profile);
      if (value.length > maxCount) {
        errors.push({
          field: label,
          message: `too many entries (max ${maxCount})`,
          limit: maxCount,
          actual: value.length,
        });
      }
    }
  }

  // ---- mutually exclusive modes ------------------------------------------
  const frameOn = [
    { on: Boolean(input.firstFrameUrl), label: "first_frame_url" },
    { on: Boolean(input.lastFrameUrl), label: "last_frame_url" },
  ].filter((f) => f.on);
  const refOn = [
    { on: hasAny(input.referenceImageUrls), label: "reference_image_urls" },
    { on: hasAny(input.referenceVideoUrls), label: "reference_video_urls" },
    { on: hasAny(input.referenceAudioUrls), label: "reference_audio_urls" },
  ].filter((f) => f.on);
  const fileLinkOn = [
    { on: hasAny(input.referenceFileUrls), label: "reference_file_urls" },
    { on: hasAny(input.referenceLinkUrls), label: "reference_link_urls" },
  ].filter((f) => f.on);

  if (frameOn.length > 0 && refOn.length > 0) {
    errors.push({
      field: "input",
      message: `first/last-frame inputs (${frameOn.map((f) => f.label).join(", ")}) cannot be combined with multimodal reference inputs (${refOn.map((f) => f.label).join(", ")})`,
    });
  }
  if (fileLinkOn.length === 2) {
    errors.push({
      field: "input",
      message: "reference_file_urls and reference_link_urls are mutually exclusive",
    });
  }
  if (fileLinkOn.length > 0 && frameOn.length > 0) {
    errors.push({
      field: "input",
      message: `file/link inputs (${fileLinkOn.map((f) => f.label).join(", ")}) cannot be combined with first/last-frame images`,
    });
  }

  // ---- prompt required for text-to-video ----------------------------------
  if (promptChars === 0 && detectWanMode(input) === "text_to_video") {
    errors.push({ field: "prompt", message: "prompt is required for text-to-video" });
  }

  // ---- duration -----------------------------------------------------------
  if (input.duration !== undefined) {
    const d = input.duration;
    if (!Number.isInteger(d)) {
      errors.push({ field: "duration", message: "must be an integer number of seconds" });
    } else if (d === -1) {
      // sentinel: model-chosen duration — allowed.
    } else if (d < profile.output.minDurationSeconds || d > profile.output.maxDurationSeconds) {
      errors.push({
        field: "duration",
        message: `must be within [${profile.output.minDurationSeconds}, ${profile.output.maxDurationSeconds}] or -1 (model decides)`,
        limit: profile.output.maxDurationSeconds,
        actual: d,
      });
    }
    // With reference videos: input video duration + output duration ≤ 30.
    if (hasAny(input.referenceVideoUrls) && Number.isInteger(d) && d > 0) {
      const inputVideoSec = context.referenceVideoSeconds;
      if (inputVideoSec !== undefined && inputVideoSec > 0 && inputVideoSec + d > profile.output.maxDurationSeconds) {
        errors.push({
          field: "duration",
          message: `input video duration (${inputVideoSec}s) + output duration (${d}s) must not exceed ${profile.output.maxDurationSeconds}s`,
          limit: profile.output.maxDurationSeconds,
          actual: inputVideoSec + d,
        });
      }
    }
  }

  // ---- resolution / aspect ratio ------------------------------------------
  if (input.resolution !== undefined && !profile.output.resolutions.includes(input.resolution)) {
    errors.push({
      field: "resolution",
      message: `must be one of ${profile.output.resolutions.join(", ")}`,
    });
  }
  if (input.aspectRatio !== undefined && !profile.output.aspectRatios.includes(input.aspectRatio)) {
    errors.push({
      field: "aspect_ratio",
      message: `must be one of ${profile.output.aspectRatios.join(", ")}`,
    });
  }

  // ---- seed -----------------------------------------------------------------
  if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647)) {
    errors.push({ field: "seed", message: "must be an integer in [0, 2147483647]" });
  }

  if (errors.length > 0) throw new WanValidationErrorList(errors);
  return { mode: detectWanMode(input), profile };
}

function isHttpUrl(value: string): boolean {
  // No `URL` in this package's lib target; parse the scheme directly.
  return /^https?:\/\//i.test(value) && /^[^\s]+$/.test(value);
}

/**
 * Billed seconds a request will consume: the output duration (default 5 when
 * omitted). `-1` (model decides) → null, unknown until completion. With
 * reference videos the provider ALSO bills the input video duration — pass
 * `referenceVideoSeconds` to include it.
 */
export function estimateBilledSeconds(input: WanVideoInput, referenceVideoSeconds = 0): number | null {
  const d = input.duration ?? getWanProfile().output.defaultDurationSeconds;
  if (d === -1) return null;
  return d + referenceVideoSeconds;
}