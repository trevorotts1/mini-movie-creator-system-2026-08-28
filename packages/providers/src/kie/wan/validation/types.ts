/**
 * KIE-006 — Wan 3.0 multimodal validation types and limits.
 *
 * Limits are the Kie Wan 3.0 constraints recorded in runbook WF05/§26.4:
 * 20,000-char prompt max; up to 10 reference images; up to 5 reference videos;
 * up to 5 reference audio; up to 30-second output; 480p/720p/1080p; and the
 * mutual exclusion between multimodal references and first/last-frame inputs.
 * Static baseline only — live provider verification (KIE-005 profile work) may
 * tighten these via the capability registry; this module enforces the floor.
 */

/** Hard character cap on a Wan 3.0 prompt (UTF-16 code units). */
export const WAN_MAX_PROMPT_CHARS = 20_000;

/** Maximum number of reference images accepted per Wan generation request. */
export const WAN_MAX_REFERENCE_IMAGES = 10;

/** Maximum number of reference videos accepted per Wan generation request. */
export const WAN_MAX_REFERENCE_VIDEOS = 5;

/** Maximum number of reference audio clips accepted per Wan generation request. */
export const WAN_MAX_REFERENCE_AUDIO = 5;

/** Maximum output duration in seconds. */
export const WAN_MAX_DURATION_SECONDS = 30;

/** Minimum output duration in seconds. */
export const WAN_MIN_DURATION_SECONDS = 1;

/** Output resolutions documented for Wan 3.0 via Kie. */
export const WAN_SUPPORTED_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type WanResolution = (typeof WAN_SUPPORTED_RESOLUTIONS)[number];

/** Stable violation codes — callers branch on these, not on message text. */
export type WanViolationCode =
  | "MISSING_PROMPT"
  | "PROMPT_TOO_LONG"
  | "TOO_MANY_REFERENCE_IMAGES"
  | "TOO_MANY_REFERENCE_VIDEOS"
  | "TOO_MANY_REFERENCE_AUDIO"
  | "MODE_CONFLICT"
  | "INVALID_REFERENCE"
  | "INVALID_DURATION"
  | "INVALID_RESOLUTION";

/** One concrete constraint violation found in a request. */
export interface WanViolation {
  code: WanViolationCode;
  /** Dotted path of the offending field (e.g. "referenceImages[10]"). */
  field: string;
  /** Human-readable, safe-to-log explanation (never embeds prompt content). */
  message: string;
}

/**
 * A Wan 3.0 generation request as assembled by the profile layer (KIE-005)
 * before submission through the generic task client (KIE-002).
 *
 * Two reference modes exist and are mutually exclusive:
 * - multimodal: `referenceImages` / `referenceVideos` / `referenceAudio`
 * - first/last-frame: `firstFrameUrl` / `lastFrameUrl`
 */
export interface WanMultimodalRequest {
  /** Story/shot prompt. Required, 1..20,000 characters. */
  prompt: string;
  /** Multimodal reference images (up to 10). */
  referenceImages?: string[];
  /** Multimodal reference videos (up to 5). */
  referenceVideos?: string[];
  /** Multimodal reference audio clips (up to 5). */
  referenceAudio?: string[];
  /** First-frame input URL (first/last-frame mode). */
  firstFrameUrl?: string;
  /** Last-frame input URL (first/last-frame mode). */
  lastFrameUrl?: string;
  /** Output duration in seconds (1..30). */
  durationSeconds?: number;
  /** Output resolution. */
  resolution?: WanResolution;
}

/** Result of validating a Wan request: fully valid, or the violation list. */
export type WanValidationResult =
  | { ok: true; request: WanMultimodalRequest }
  | { ok: false; violations: WanViolation[] };