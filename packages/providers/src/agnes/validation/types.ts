/**
 * AGN-008 — Agnes first/last/reference validation types.
 *
 * Pre-flight request-shape validation for the Agnes Video 2.5 family
 * (`agnes-video-2.5-flash`, `agnes-video-2.5`), run BEFORE any provider call
 * (runbook §16 pre-request validation, §25 acceptance: "first-frame,
 * last-frame, reference-image request shapes validated against profile before
 * call; invalid combination rejected pre-flight").
 *
 * Provider facts encoded (live official docs verified 2026-08-28 —
 * https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash and /agnes-video-25;
 * see docs/provider-capabilities/agnes.md):
 *   - Exactly one generation mode per request: `text`, `keyframe`, or
 *     `reference`. Keyframe requires ≥1 of first_frame/last_frame and
 *     disallows images/audios/videos; reference requires ≥1 non-empty media
 *     array and disallows first_frame/last_frame; text disallows all media.
 *   - Flash: `size` fixed "720P"; `images` max 5 (HTTP 400 beyond); `videos`
 *     never supported (HTTP 400 "videos is not supported").
 *   - Regular: sizes 720P/960P/2K; reference videos accepted (objects with
 *     url/start_seconds/require_audio).
 *   - Reference counts the docs do NOT state (regular images/videos/audios,
 *     Flash audios) stay UNKNOWN (null) and are NEVER enforced — runbook §16
 *     "UNKNOWN is valid. Never invent a hard Agnes limit because another
 *     model has one."
 *
 * Pure module — no I/O, no fetch. The adapter composes the request from the
 * shot plan, this validator runs first, then the client (AGN-001) sends.
 */

/** Agnes generation modes — exactly one per request. */
export type AgnesVideoMode = "text" | "keyframe" | "reference";

/** One `videos[]` entry of Agnes Video 2.5 reference mode (regular only). */
export interface AgnesReferenceVideo {
  /** Required by the provider. */
  url: string;
  /** Seconds into the video the reference starts. Default 0. */
  startSeconds?: number;
  /** Whether the reference clip's audio is used. Default false. */
  requireAudio?: boolean;
}

/**
 * The provider-agnostic request shape the Agnes video adapter builds, before
 * it is mapped onto the exact Agnes field names (first_frame, last_frame,
 * images, audios, videos, seconds, size, aspect_ratio). Empty strings and
 * empty arrays are treated as absent, matching the CAP-005 convention.
 */
export interface AgnesVideoRequestShape {
  /**
   * Explicit `mode` field. Optional here — when absent, the mode is inferred
   * from which fields are present; when present it must agree with the fields.
   */
  mode?: AgnesVideoMode;
  /** Required by the provider (every mode). */
  prompt?: string;
  /** Exact starting frame → keyframe mode. */
  firstFrameUrl?: string;
  /** Exact ending frame → keyframe mode. Agnes accepts a lone last frame. */
  lastFrameUrl?: string;
  /** `images[]` reference URLs → reference mode. */
  referenceImageUrls?: readonly string[];
  /** `audios[]` reference URLs → reference mode. */
  referenceAudioUrls?: readonly string[];
  /** `videos[]` reference clips → reference mode. */
  referenceVideos?: readonly AgnesReferenceVideo[];
  /** Duration; provider takes string "4"–"12". Numbers accepted and normalized. */
  seconds?: string | number;
  /** Output size, e.g. "720P" (Flash) / "720P" | "960P" | "2K" (regular). */
  size?: string;
  /** Aspect ratio, e.g. "16:9". */
  aspectRatio?: string;
}

/**
 * The capability-profile slice this validator reads. Structurally satisfied
 * by the CAP-002 `MediaModelCapabilitySeed` for the modelId/prompt/references
 * slices; `referenceVideoSupported` and the nullable `resolutions` are Agnes
 * facts the caller supplies via {@link toAgnesValidationProfile}. null limits
 * are UNKNOWN and never enforced.
 */
export interface AgnesValidationProfile {
  modelId: string;
  prompt: {
    /** null = undocumented (Agnes) — never enforced. */
    hardMaxCharacters: number | null;
  };
  references: {
    maxImages: number | null;
    maxVideos: number | null;
    maxAudio: number | null;
    firstFrame: boolean;
    lastFrame: boolean;
    firstLastFrame: boolean;
    multimodalReferences: boolean;
    /** Flash: false (HTTP 400 "videos is not supported"); regular: true. */
    referenceVideoSupported: boolean;
  };
  output: {
    minDurationSeconds: number | null;
    maxDurationSeconds: number | null;
    /** null = no verified size list — size is then not checked. */
    resolutions: readonly string[] | null;
  };
}

/** A single validation defect. Message names the field and the violated rule. */
export interface AgnesValidationIssue {
  /** Request field (or "mode" for mode-level defects). */
  field: string;
  /** Machine-readable code (stable for downstream tests/routing). */
  code: AgnesValidationIssueCode;
  /** Human-readable explanation; safe to log. */
  message: string;
}

/** Stable issue codes (stable for downstream tests/routing). */
export type AgnesValidationIssueCode =
  | "MISSING_PROMPT"
  | "PROMPT_TOO_LONG"
  | "UNKNOWN_MODE"
  | "MODE_FIELDS_CONFLICT"
  | "TEXT_MODE_MEDIA_FIELDS"
  | "KEYFRAME_REQUIRES_FRAME"
  | "KEYFRAME_DISALLOWS_REFERENCE_MEDIA"
  | "REFERENCE_REQUIRES_MEDIA"
  | "REFERENCE_DISALLOWS_FRAME_FIELDS"
  | "FIRST_FRAME_NOT_SUPPORTED"
  | "LAST_FRAME_NOT_SUPPORTED"
  | "FIRST_LAST_FRAME_COMBINATION_NOT_SUPPORTED"
  | "MULTIMODAL_REFERENCES_NOT_SUPPORTED"
  | "REFERENCE_VIDEOS_NOT_SUPPORTED"
  | "TOO_MANY_REFERENCE_IMAGES"
  | "TOO_MANY_REFERENCE_VIDEOS"
  | "TOO_MANY_REFERENCE_AUDIOS"
  | "INVALID_REFERENCE_ENTRY"
  | "INVALID_REFERENCE_VIDEO_ENTRY"
  | "INVALID_PROFILE_LIMIT"
  | "INVALID_SECONDS"
  | "INVALID_SIZE";

/** Result of {@link validateAgnesRequest}. */
export interface AgnesValidationResult {
  /** true when the request may be submitted (zero issues). */
  ok: boolean;
  /**
   * The single effective mode of the request: the explicit `mode` when given
   * and consistent, else the mode inferred from the present fields; null when
   * fields conflict (no single mode exists — always accompanied by issues).
   */
  mode: AgnesVideoMode | null;
  issues: readonly AgnesValidationIssue[];
}
