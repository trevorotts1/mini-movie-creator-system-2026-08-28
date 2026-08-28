/**
 * KIE-004 — Seedance generation modes and request validation.
 *
 * Facts verified against docs.kie.ai/market/bytedance/seedance-2-mini on
 * 2026-08-28 (Kie docs authoritative per runbook §26.3; unstated numerics
 * stay UNKNOWN, never invented):
 *   - Model slug: `bytedance/seedance-2-mini`
 *   - Four mutually exclusive scenarios ("cannot be used simultaneously"):
 *       1. text-to-video (no images at all)
 *       2. I2V first frame only (`first_frame_url`, no `last_frame_url`)
 *       3. I2V first+last frames (`first_frame_url` + `last_frame_url`)
 *       4. multimodal reference (`reference_image_urls` / `reference_video_urls` /
 *          `reference_audio_urls`, any mix)
 *     The first/last-frame fields can NEVER be combined with reference
 *     image/video/audio fields.
 *   - `last_frame_url` alone is NOT a documented mode — rejected.
 *   - `web_search` is t2v-only.
 *   - `prompt`: 3–20000 chars (documented; the 20000 upper bound is Seedance-2
 *     family, not the Wan-only baseline).
 *   - `duration`: integer seconds 4–15 (default 5).
 *   - `resolution`: `480p` | `720p` (default 720p).
 *   - `aspect_ratio`: `1:1|4:3|3:4|16:9|9:16|21:9|adaptive` (default 16:9).
 *   - Counts: reference images max 9, videos max 3, audios max 3.
 *   - `generate_audio`: boolean, default true; `nsfw_checker`: boolean, default false.
 *
 * This module owns ONLY mode selection + pre-flight validation. It is pure —
 * no I/O, no fetch. The adapter (KIE-003 profile) composes the payload, the
 * client (KIE-001) sends it, the runner (KIE-002) submits/polls it.
 */

/** Model slug for Seedance 2.0 Mini on Kie (docs.kie.ai, verified 2026-08-28). */
export const SEEDANCE_2_MINI_MODEL = "bytedance/seedance-2-mini";

/**
 * The four Seedance generation modes. Exactly one is active per request and
 * the caller states it explicitly via {@link SeedanceRequest.mode} — the
 * validator never infers a mode from field presence, so a payload that
 * disagrees with its declared mode is a validation error, not a silent remap.
 */
export type SeedanceMode =
  | "text-to-video"
  | "first-frame"
  | "first-last-frame"
  | "multimodal-reference";

/** All modes, in canonical order (tests/errors iterate deterministically). */
export const SEEDANCE_MODES: readonly SeedanceMode[] = [
  "text-to-video",
  "first-frame",
  "first-last-frame",
  "multimodal-reference",
] as const;

/** Documented aspect ratios (docs.kie.ai 2026-08-28). */
export const SEEDANCE_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
  "adaptive",
] as const;
export type SeedanceAspectRatio = (typeof SEEDANCE_ASPECT_RATIOS)[number];

/** Documented resolutions (docs.kie.ai 2026-08-28). */
export const SEEDANCE_RESOLUTIONS = ["480p", "720p"] as const;
export type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number];

/** Documented prompt bounds, inclusive (docs.kie.ai 2026-08-28). */
export const SEEDANCE_PROMPT_MIN_CHARS = 3;
export const SEEDANCE_PROMPT_MAX_CHARS = 20000;

/** Documented duration bounds, integer seconds, inclusive. */
export const SEEDANCE_DURATION_MIN_S = 4;
export const SEEDANCE_DURATION_MAX_S = 15;

/** Documented reference-count maxima (docs.kie.ai 2026-08-28). */
export const SEEDANCE_MAX_REFERENCE_IMAGES = 9;
export const SEEDANCE_MAX_REFERENCE_VIDEOS = 3;
export const SEEDANCE_MAX_REFERENCE_AUDIOS = 3;

/** Which reference inputs a mode uses, for error messages and routing. */
export interface SeedanceModeCapabilities {
  /** Mode accepts a first frame (`first_frame_url`). */
  firstFrame: boolean;
  /** Mode accepts a last frame (`last_frame_url`, requires first frame). */
  lastFrame: boolean;
  /** Mode accepts reference images/videos/audio. */
  references: boolean;
  /** Mode accepts `web_search`. */
  webSearch: boolean;
}

/** Per-mode capability matrix derived from the documented scenarios. */
export const SEEDANCE_MODE_CAPABILITIES: Readonly<
  Record<SeedanceMode, SeedanceModeCapabilities>
> = {
  "text-to-video": { firstFrame: false, lastFrame: false, references: false, webSearch: true },
  "first-frame": { firstFrame: true, lastFrame: false, references: false, webSearch: false },
  "first-last-frame": { firstFrame: true, lastFrame: true, references: false, webSearch: false },
  "multimodal-reference": {
    firstFrame: false,
    lastFrame: false,
    references: true,
    webSearch: false,
  },
};

/** True when a value looks like a usable http(s)/asset:// reference URL. */
export function isReferenceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  const scheme = ["http://", "https://", "asset://"].find((s) => v.startsWith(s));
  if (scheme === undefined) return false;
  // Require a non-empty, non-path/non-query authority: "http://", "https://",
  // "asset://", "asset:///x" are all unusable.
  const rest = v.slice(scheme.length);
  return (
    rest.length > 0 && !rest.startsWith("/") && !rest.startsWith("?") && !rest.startsWith("#")
  );
}

/** True for a usable http(s) webhook URL. asset:// refs are NOT callbacks. */
export function isCallbackUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  const scheme = ["https://", "http://"].find((s) => v.startsWith(s));
  if (scheme === undefined) return false;
  const rest = v.slice(scheme.length);
  return (
    rest.length > 0 && !rest.startsWith("/") && !rest.startsWith("?") && !rest.startsWith("#")
  );
}

/**
 * One Seedance generation request. `mode` is REQUIRED and explicit — this is
 * the load-bearing contract of KIE-004: callers select the mode per request,
 * and the validator enforces that the rest of the request matches it.
 */
export interface SeedanceRequest {
  /** Explicitly selected generation mode. No default, no inference. */
  mode: SeedanceMode;
  /** Scene description. 3–20000 chars. */
  prompt: string;
  /** I2V input. Required for first-frame / first-last-frame; forbidden elsewhere. */
  firstFrameUrl?: string;
  /** I2V input. Allowed only with firstFrameUrl in first-last-frame mode. */
  lastFrameUrl?: string;
  /** Multimodal reference images. Required (≥1) in multimodal-reference; forbidden elsewhere. */
  referenceImageUrls?: string[];
  /** Multimodal reference videos (optional, max 3). Forbidden outside multimodal-reference. */
  referenceVideoUrls?: string[];
  /** Multimodal reference audio (optional, max 3). Forbidden outside multimodal-reference. */
  referenceAudioUrls?: string[];
  /** Aspect ratio. Default 16:9. */
  aspectRatio?: SeedanceAspectRatio;
  /** Resolution. Default 720p. */
  resolution?: SeedanceResolution;
  /** Output length in integer seconds (4–15). Default 5. */
  durationSeconds?: number;
  /** t2v-only online search. Forbidden in every other mode. */
  webSearch?: boolean;
  /** Optional generate-audio toggle. Default true per provider docs. */
  generateAudio?: boolean;
  /** Optional content-filter toggle. Default false per provider docs. */
  nsfwChecker?: boolean;
  /**
   * Optional provider callback URL (http(s):// only — Kie webhooks reach out,
   * so asset:// refs are meaningless here). Emitted as `callBackUrl` on the
   * createTask body (KIE-002 `KieCreateTaskRequest.callBackUrl`).
   */
  callBackUrl?: string;
}

/** A single validation defect. Message names the field and the violated rule. */
export interface SeedanceValidationIssue {
  /** Request field (or "mode") the defect belongs to. */
  field: string;
  /** Machine-readable rule identifier (stable for downstream tests/routing). */
  code: string;
  /** Human-readable explanation; safe to log. */
  message: string;
}

/** Thrown by {@link validateSeedanceRequest} on any pre-flight failure. */
export class SeedanceValidationError extends Error {
  readonly errors: readonly SeedanceValidationIssue[];
  constructor(errors: readonly SeedanceValidationIssue[]) {
    super(`Seedance request failed validation (${errors.length} issue(s)): ${errors
      .map((e) => `[${e.code}] ${e.field}: ${e.message}`)
      .join("; ")}`);
    this.name = "SeedanceValidationError";
    this.errors = errors;
  }
}

/** Which mode the request's image/reference fields imply, or null for none. */
function impliedMode(request: SeedanceRequest): SeedanceMode | null {
  const hasFirst = request.firstFrameUrl !== undefined;
  const hasLast = request.lastFrameUrl !== undefined;
  const hasRefs =
    (request.referenceImageUrls?.length ?? 0) > 0 ||
    (request.referenceVideoUrls?.length ?? 0) > 0 ||
    (request.referenceAudioUrls?.length ?? 0) > 0;
  if ((hasFirst || hasLast) && hasRefs) return "multimodal-reference"; // conflict; caller must reject
  if (hasFirst && hasLast) return "first-last-frame";
  if (hasFirst) return "first-frame";
  // hasLast-only is illegal; inferSeedanceMode rejects it before this branch.
  if (hasRefs) return "multimodal-reference";
  return "text-to-video";
}

/** Field-presence facts used by the mode-consistency check. */
interface FieldPresence {
  firstFrame: boolean;
  lastFrame: boolean;
  images: number;
  videos: number;
  audios: number;
  webSearch: boolean;
}

function fieldPresence(request: SeedanceRequest): FieldPresence {
  return {
    firstFrame: request.firstFrameUrl !== undefined,
    lastFrame: request.lastFrameUrl !== undefined,
    images: request.referenceImageUrls?.length ?? 0,
    videos: request.referenceVideoUrls?.length ?? 0,
    audios: request.referenceAudioUrls?.length ?? 0,
    webSearch: request.webSearch === true,
  };
}

/**
 * Collect every violation of mode exclusivity for the declared mode.
 * Returns [] when the declared mode and the fields agree exactly.
 */
function exclusivityErrors(mode: SeedanceMode, request: SeedanceRequest): SeedanceValidationIssue[] {
  const errors: SeedanceValidationIssue[] = [];
  const presence = fieldPresence(request);
  const caps = SEEDANCE_MODE_CAPABILITIES[mode];

  // First/last-frame fields combined with any reference field — the hard
  // cross-mode conflict the provider docs call out explicitly.
  const usesFrames = presence.firstFrame || presence.lastFrame;
  const usesRefs = presence.images > 0 || presence.videos > 0 || presence.audios > 0;
  if (usesFrames && usesRefs) {
    errors.push({
      field: "mode",
      code: "MUTUALLY_EXCLUSIVE_MODES",
      message:
        "first/last-frame inputs cannot be combined with reference_image_urls/reference_video_urls/reference_audio_urls — pick one generation mode",
    });
    return errors; // cross-mode conflict dominates; individual checks below are moot
  }

  if (presence.firstFrame && !caps.firstFrame) {
    errors.push({
      field: "firstFrameUrl",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `first_frame_url is not part of the "${mode}" mode`,
    });
  }
  if (presence.lastFrame && !caps.lastFrame) {
    errors.push({
      field: "lastFrameUrl",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `last_frame_url is not part of the "${mode}" mode`,
    });
  }
  if (presence.images > 0 && !caps.references) {
    errors.push({
      field: "referenceImageUrls",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `reference_image_urls is not part of the "${mode}" mode`,
    });
  }
  if (presence.videos > 0 && !caps.references) {
    errors.push({
      field: "referenceVideoUrls",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `reference_video_urls is not part of the "${mode}" mode`,
    });
  }
  if (presence.audios > 0 && !caps.references) {
    errors.push({
      field: "referenceAudioUrls",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `reference_audio_urls is not part of the "${mode}" mode`,
    });
  }
  if (presence.webSearch && !caps.webSearch) {
    errors.push({
      field: "webSearch",
      code: "FIELD_NOT_ALLOWED_IN_MODE",
      message: `web_search is t2v-only and not part of the "${mode}" mode`,
    });
  }
  return errors;
}

/** Missing required fields for the declared mode (last-only frame etc.). */
function requiredFieldErrors(mode: SeedanceMode, request: SeedanceRequest): SeedanceValidationIssue[] {
  const errors: SeedanceValidationIssue[] = [];
  const presence = fieldPresence(request);
  const usesFrames = presence.firstFrame || presence.lastFrame;
  const usesRefs = presence.images > 0 || presence.videos > 0 || presence.audios > 0;

  if (mode === "first-frame" && !request.firstFrameUrl) {
    errors.push({
      field: "firstFrameUrl",
      code: "MODE_FIELD_REQUIRED",
      message: 'the "first-frame" mode requires firstFrameUrl',
    });
  }
  if (mode === "first-last-frame") {
    if (!request.firstFrameUrl) {
      errors.push({
        field: "firstFrameUrl",
        code: "MODE_FIELD_REQUIRED",
        message: 'the "first-last-frame" mode requires firstFrameUrl',
      });
    }
    if (!request.lastFrameUrl) {
      errors.push({
        field: "lastFrameUrl",
        code: "MODE_FIELD_REQUIRED",
        message: 'the "first-last-frame" mode requires lastFrameUrl',
      });
    }
  }
  if (mode === "multimodal-reference" && !usesRefs) {
    errors.push({
      field: "referenceImageUrls",
      code: "MODE_FIELD_REQUIRED",
      message: 'the "multimodal-reference" mode requires at least one reference (image/video/audio)',
    });
  }
  // last_frame_url without first_frame_url is not a documented scenario.
  if (usesFrames && !presence.firstFrame && presence.lastFrame && !usesRefs) {
    errors.push({
      field: "lastFrameUrl",
      code: "LAST_FRAME_WITHOUT_FIRST",
      message: "last_frame_url without first_frame_url is not a supported Seedance scenario",
    });
  }
  return errors;
}

/** Shared scalar/enum/range checks (mode-independent). */
function scalarErrors(request: SeedanceRequest): SeedanceValidationIssue[] {
  const errors: SeedanceValidationIssue[] = [];
  const prompt = request.prompt;
  if (typeof prompt !== "string" || prompt.trim().length < SEEDANCE_PROMPT_MIN_CHARS) {
    errors.push({
      field: "prompt",
      code: "PROMPT_TOO_SHORT",
      message: `prompt must be at least ${SEEDANCE_PROMPT_MIN_CHARS} characters`,
    });
  } else if (prompt.length > SEEDANCE_PROMPT_MAX_CHARS) {
    errors.push({
      field: "prompt",
      code: "PROMPT_TOO_LONG",
      message: `prompt exceeds the documented ${SEEDANCE_PROMPT_MAX_CHARS}-character maximum`,
    });
  }

  const duration = request.durationSeconds;
  if (duration !== undefined) {
    if (!Number.isInteger(duration) || duration < SEEDANCE_DURATION_MIN_S || duration > SEEDANCE_DURATION_MAX_S) {
      errors.push({
        field: "durationSeconds",
        code: "DURATION_OUT_OF_RANGE",
        message: `durationSeconds must be an integer between ${SEEDANCE_DURATION_MIN_S} and ${SEEDANCE_DURATION_MAX_S}`,
      });
    }
  }

  if (request.aspectRatio !== undefined && !(SEEDANCE_ASPECT_RATIOS as readonly string[]).includes(request.aspectRatio)) {
    errors.push({
      field: "aspectRatio",
      code: "INVALID_ASPECT_RATIO",
      message: `aspectRatio must be one of ${SEEDANCE_ASPECT_RATIOS.join(", ")}`,
    });
  }
  if (request.resolution !== undefined && !(SEEDANCE_RESOLUTIONS as readonly string[]).includes(request.resolution)) {
    errors.push({
      field: "resolution",
      code: "INVALID_RESOLUTION",
      message: `resolution must be one of ${SEEDANCE_RESOLUTIONS.join(", ")}`,
    });
  }

  if (request.firstFrameUrl !== undefined && !isReferenceUrl(request.firstFrameUrl)) {
    errors.push({
      field: "firstFrameUrl",
      code: "INVALID_REFERENCE_URL",
      message: "firstFrameUrl must be an http(s):// or asset:// URL",
    });
  }
  if (request.lastFrameUrl !== undefined && !isReferenceUrl(request.lastFrameUrl)) {
    errors.push({
      field: "lastFrameUrl",
      code: "INVALID_REFERENCE_URL",
      message: "lastFrameUrl must be an http(s):// or asset:// URL",
    });
  }
  if (request.callBackUrl !== undefined && !isCallbackUrl(request.callBackUrl)) {
    errors.push({
      field: "callBackUrl",
      code: "INVALID_CALLBACK_URL",
      message: "callBackUrl must be an http(s):// URL",
    });
  }

  const countChecks: Array<[string, string[] | undefined, number]> = [
    ["referenceImageUrls", request.referenceImageUrls, SEEDANCE_MAX_REFERENCE_IMAGES],
    ["referenceVideoUrls", request.referenceVideoUrls, SEEDANCE_MAX_REFERENCE_VIDEOS],
    ["referenceAudioUrls", request.referenceAudioUrls, SEEDANCE_MAX_REFERENCE_AUDIOS],
  ];
  for (const [field, list, max] of countChecks) {
    if (list === undefined) continue;
    for (const [i, url] of list.entries()) {
      if (!isReferenceUrl(url)) {
        errors.push({
          field: field,
          code: "INVALID_REFERENCE_URL",
          message: `${field}[${i}] must be an http(s):// or asset:// URL`,
        });
      }
    }
    if (list.length > max) {
      errors.push({
        field: field,
        code: "TOO_MANY_REFERENCES",
        message: `${field} allows at most ${max} entries (got ${list.length})`,
      });
    }
  }
  return errors;
}

/**
 * Pre-flight validate a Seedance request. Throws {@link SeedanceValidationError}
 * listing EVERY violation found (not just the first) so callers can fix the
 * whole request in one pass. The declared `mode` must match the fields present;
 * the validator never silently remaps a request into a different mode.
 */
export function validateSeedanceRequest(request: SeedanceRequest): void {
  const errors: SeedanceValidationIssue[] = [];

  if (!SEEDANCE_MODES.includes(request.mode)) {
    errors.push({
      field: "mode",
      code: "MODE_REQUIRED",
      message: `mode is required and must be one of: ${SEEDANCE_MODES.join(", ")}`,
    });
  } else {
    errors.push(...exclusivityErrors(request.mode, request));
    errors.push(...requiredFieldErrors(request.mode, request));
  }

  errors.push(...scalarErrors(request));

  if (errors.length > 0) {
    throw new SeedanceValidationError(errors);
  }
}

/**
 * Full createTask body for `bytedance/seedance-2-mini`. `input` holds the
 * model-specific payload; `callBackUrl` is a createTask-level field
 * (KIE-002 `KieCreateTaskRequest`), NOT an input field — KIE-003's
 * `buildSeedanceRequest` has the same shape.
 */
export interface SeedanceTaskRequest {
  model: string;
  input: Record<string, unknown>;
  callBackUrl?: string;
}

/**
 * Map a validated request onto the Kie createTask `input` payload for
 * `bytedance/seedance-2-mini`. Only mode-permitted fields are emitted —
 * validation guarantees no mutually exclusive fields coexist. Defaults mirror
 * the provider docs (aspect_ratio 16:9, resolution 720p, duration 5).
 */
export function buildSeedanceInput(request: SeedanceRequest): Record<string, unknown> {
  validateSeedanceRequest(request);

  const input: Record<string, unknown> = { prompt: request.prompt };
  if (request.firstFrameUrl !== undefined) input["first_frame_url"] = request.firstFrameUrl;
  if (request.lastFrameUrl !== undefined) input["last_frame_url"] = request.lastFrameUrl;
  if (request.referenceImageUrls !== undefined && request.referenceImageUrls.length > 0) {
    input["reference_image_urls"] = [...request.referenceImageUrls];
  }
  if (request.referenceVideoUrls !== undefined && request.referenceVideoUrls.length > 0) {
    input["reference_video_urls"] = [...request.referenceVideoUrls];
  }
  if (request.referenceAudioUrls !== undefined && request.referenceAudioUrls.length > 0) {
    input["reference_audio_urls"] = [...request.referenceAudioUrls];
  }
  input["aspect_ratio"] = request.aspectRatio ?? "16:9";
  input["resolution"] = request.resolution ?? "720p";
  input["duration"] = request.durationSeconds ?? 5;
  if (request.webSearch !== undefined) input["web_search"] = request.webSearch;
  if (request.generateAudio !== undefined) input["generate_audio"] = request.generateAudio;
  if (request.nsfwChecker !== undefined) input["nsfw_checker"] = request.nsfwChecker;
  return input;
}

/**
 * Full createTask body for a validated request: model slug, the mode-scoped
 * `input` payload, and the optional `callBackUrl` at the createTask level
 * (matches KIE-002 `KieCreateTaskRequest` / KIE-003 `buildSeedanceRequest`).
 */
export function buildSeedanceTaskRequest(request: SeedanceRequest): SeedanceTaskRequest {
  const body: SeedanceTaskRequest = {
    model: SEEDANCE_2_MINI_MODEL,
    input: buildSeedanceInput(request),
  };
  if (request.callBackUrl !== undefined) body.callBackUrl = request.callBackUrl;
  return body;
}

/**
 * Convenience for the video router (spec §27): the single mode a request's
 * fields imply — "text-to-video" when no image/reference field is present —
 * or null when the fields are invalid or conflicting (last-frame without
 * first, frames + references mixed). Callers still must state `mode`
 * explicitly; this helper only powers diagnostics and fallback routing.
 */
export function inferSeedanceMode(request: SeedanceRequest): SeedanceMode | null {
  const presence = fieldPresence(request);
  const usesFrames = presence.firstFrame || presence.lastFrame;
  const usesRefs = presence.images > 0 || presence.videos > 0 || presence.audios > 0;
  if (usesFrames && usesRefs) return null; // cross-mode conflict
  if (presence.lastFrame && !presence.firstFrame) return null; // illegal last-only
  return impliedMode(request);
}