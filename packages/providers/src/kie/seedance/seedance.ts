/**
 * Seedance 2.0 Mini adapter (@mmcs/providers/kie/seedance).
 *
 * Task KIE-003. Wraps the Kie "jobs" API for the model
 * `bytedance/seedance-2-mini` and tracks the three mutually exclusive
 * generation modes the Kie schema defines:
 *
 *  - first-frame I2V            (`first_frame_url` only)
 *  - first+last-frame I2V       (`first_frame_url` + `last_frame_url`)
 *  - multimodal-reference       (`reference_image_urls` and/or
 *                                `reference_video_urls` and/or
 *                                `reference_audio_urls`)
 *
 * Schema verified live against https://docs.kie.ai/market/bytedance/seedance-2-mini
 * on 2026-08-28. Every number the doc states is encoded as a VERIFIED limit;
 * anything the doc does not state stays UNKNOWN/PROVISIONAL — never invented
 * (spec §26.3).
 */

/** Kie API base URL. */
export const KIE_API_BASE = "https://api.kie.ai";

/** Exact model identifier accepted by the Kie createTask endpoint. */
export const SEEDANCE_2_MINI_MODEL = "bytedance/seedance-2-mini";

/** The three mutually exclusive generation modes (spec §26.3). */
export type SeedanceGenerationMode =
  | "first-frame-i2v"
  | "first-last-frame-i2v"
  | "multimodal-reference";

/** A capability limit whose value the live Kie doc does NOT state. */
export interface UnknownLimit {
  readonly status: "UNKNOWN";
  /** Why the value is unknown — where verification was attempted. */
  readonly note: string;
}

/** A capability limit stated by the live Kie doc. */
export interface VerifiedLimit<T> {
  readonly status: "VERIFIED";
  /** Kie doc URL the value was read from. */
  readonly source: string;
  /** Date the doc was verified, ISO YYYY-MM-DD. */
  readonly verifiedOn: string;
  readonly value: T;
}

/** Either a verified value or an explicit UNKNOWN. */
export type Limit<T> = VerifiedLimit<T> | UnknownLimit;

/** Doc-stated per-item reference image requirements. */
export interface ReferenceImageLimits {
  readonly maxCount: number;
  readonly formats: readonly string[];
  /** Width/height px range (inclusive per doc wording). */
  readonly pxRange: readonly [number, number];
  /** Width/height aspect-ratio range (exclusive per doc wording). */
  readonly aspectRatioRange: readonly [number, number];
  readonly maxSingleFileMb: number;
}

/** Doc-stated per-item reference video requirements. */
export interface ReferenceVideoLimits {
  readonly maxCount: number;
  readonly formats: readonly string[];
  readonly resolutions: readonly string[];
  /** Single-video duration range in seconds. */
  readonly durationSecondsRange: readonly [number, number];
  readonly maxTotalDurationSeconds: number;
  readonly aspectRatioRange: readonly [number, number];
  readonly pxRange: readonly [number, number];
  /** Total-pixels (width × height) range. */
  readonly totalPxRange: readonly [number, number];
  readonly maxSingleFileMb: number;
  readonly fpsRange: readonly [number, number];
}

/** Doc-stated per-item reference audio requirements. */
export interface ReferenceAudioLimits {
  readonly maxCount: number;
  readonly formats: readonly string[];
  readonly durationSecondsRange: readonly [number, number];
  readonly maxTotalDurationSeconds: number;
  readonly maxSingleFileMb: number;
}

const DOC_URL = "https://docs.kie.ai/market/bytedance/seedance-2-mini";
const VERIFIED_ON = "2026-08-28";

/** Numeric limits exactly as stated by the live Kie schema (2026-08-28). */
export const SEEDANCE_2_MINI_LIMITS: Readonly<{
  /** prompt string length, min inclusive / max inclusive. */
  promptLength: VerifiedLimit<{ min: number; max: number }>;
  resolution: VerifiedLimit<readonly string[]>;
  resolutionDefault: VerifiedLimit<string>;
  aspectRatio: VerifiedLimit<readonly string[]>;
  aspectRatioDefault: VerifiedLimit<string>;
  /** Doc description says 4-15 s but the schema states no min/max — PROVISIONAL. */
  durationSeconds: VerifiedLimit<{ min: number; max: number }>;
  durationDefault: VerifiedLimit<number>;
  referenceImages: VerifiedLimit<ReferenceImageLimits>;
  referenceVideos: VerifiedLimit<ReferenceVideoLimits>;
  referenceAudios: VerifiedLimit<ReferenceAudioLimits>;
  /** Doc shows the field only in an example payload; not in schema properties. */
  returnLastFrame: UnknownLimit;
  /** Rate limit is account-wide, not model-specific. */
  newRequestsPer10Seconds: VerifiedLimit<number>;
}> = {
  promptLength: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: { min: 3, max: 20000 },
  },
  resolution: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: ["480p", "720p"],
  },
  resolutionDefault: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: "720p",
  },
  aspectRatio: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"],
  },
  aspectRatioDefault: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: "16:9",
  },
  durationSeconds: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: { min: 4, max: 15 },
  },
  durationDefault: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: 5,
  },
  referenceImages: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: {
      maxCount: 9,
      formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif"],
      pxRange: [300, 6000],
      aspectRatioRange: [0.4, 2.5],
      maxSingleFileMb: 30,
    },
  },
  referenceVideos: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: {
      maxCount: 3,
      formats: ["mp4", "mov"],
      resolutions: ["480p", "720p"],
      durationSecondsRange: [2, 15],
      maxTotalDurationSeconds: 15,
      aspectRatioRange: [0.4, 2.5],
      pxRange: [300, 6000],
      totalPxRange: [409600, 927408],
      maxSingleFileMb: 50,
      fpsRange: [24, 60],
    },
  },
  referenceAudios: {
    status: "VERIFIED",
    source: DOC_URL,
    verifiedOn: VERIFIED_ON,
    value: {
      maxCount: 3,
      formats: ["wav", "mp3"],
      durationSecondsRange: [2, 15],
      maxTotalDurationSeconds: 15,
      maxSingleFileMb: 15,
    },
  },
  returnLastFrame: {
    status: "UNKNOWN",
    note: `Doc schema properties omit return_last_frame for ${SEEDANCE_2_MINI_MODEL} (present only in an example payload; on seedance-2/seedance-2-fast it is deprecated). Treated PROVISIONAL/UNKNOWN — do not send.`,
  },
  newRequestsPer10Seconds: {
    status: "VERIFIED",
    source: "https://docs.kie.ai/market/quickstart",
    verifiedOn: VERIFIED_ON,
    value: 20,
  },
};

/** Input options accepted by the adapter, keyed by exact Kie field names. */
export interface SeedanceInput {
  /** 3–20000 chars. */
  prompt: string;
  /** First-frame image URL or `asset://{assetId}`. */
  firstFrameUrl?: string;
  /** Last-frame image URL or `asset://{assetId}`. Requires firstFrameUrl. */
  lastFrameUrl?: string;
  /** Reference images (multimodal-reference mode). Max 9. */
  referenceImageUrls?: readonly string[];
  /** Reference videos (multimodal-reference mode). Max 3, ≤15 s total. */
  referenceVideoUrls?: readonly string[];
  /** Reference audios (multimodal-reference mode). Max 3, ≤15 s total. */
  referenceAudioUrls?: readonly string[];
  /** `480p` | `720p`. Default `720p`. */
  resolution?: "480p" | "720p";
  /** Default `16:9`. */
  aspectRatio?:
    | "1:1"
    | "4:3"
    | "3:4"
    | "16:9"
    | "9:16"
    | "21:9"
    | "adaptive";
  /** 4–15 seconds (doc description; schema states no numeric bounds). */
  duration?: number;
  /** Generate audio track. Default true. */
  generateAudio?: boolean;
  /** Text-to-video only per Kie docs. */
  webSearch?: boolean;
  /** Content filtering toggle. Default false. */
  nsfwChecker?: boolean;
  /** Completion callback URL (optional, recommended by Kie). */
  callbackUrl?: string;
}

/** Inputs that may reach the mode classifier. */
export interface SeedanceGenerationInput extends Pick<
  SeedanceInput,
  | "firstFrameUrl"
  | "lastFrameUrl"
  | "referenceImageUrls"
  | "referenceVideoUrls"
  | "referenceAudioUrls"
> {
  /** Classifier ignores the prompt; accepted for call-site convenience. */
  prompt?: string;
}

/** Classify a validated input into its single generation mode. */
export function generationMode(
  input: SeedanceGenerationInput,
): SeedanceGenerationMode {
  if (input.firstFrameUrl !== undefined && input.lastFrameUrl !== undefined) {
    return "first-last-frame-i2v";
  }
  if (input.firstFrameUrl !== undefined) return "first-frame-i2v";
  return "multimodal-reference";
}

/** A single validation failure against the live Kie schema. */
export interface SeedanceValidationError {
  /** Dotted path to the offending field (e.g. "input.prompt"). */
  field: string;
  message: string;
}

/** Result of validating a request against the live Kie schema. */
export interface SeedanceValidationResult {
  ok: boolean;
  mode?: SeedanceGenerationMode;
  errors: SeedanceValidationError[];
}

/** Full createTask request the adapter builds. */
export interface SeedanceRequest {
  model: string;
  input: {
    prompt: string;
    first_frame_url?: string;
    last_frame_url?: string;
    reference_image_urls?: string[];
    reference_video_urls?: string[];
    reference_audio_urls?: string[];
    generate_audio?: boolean;
    resolution?: string;
    aspect_ratio?: string;
    duration?: number;
    web_search?: boolean;
    nsfw_checker?: boolean;
  };
  callBackUrl?: string;
}

const ASSET_SCHEME = /^asset:\/\/asset-[\w-]+$/;

function isAssetRef(url: string): boolean {
  return ASSET_SCHEME.test(url);
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Non-empty reference arrays present (multimodal-reference signals). */
function hasReferenceInputs(input: SeedanceGenerationInput): boolean {
  return (
    (input.referenceImageUrls !== undefined &&
      input.referenceImageUrls.length > 0) ||
    (input.referenceVideoUrls !== undefined &&
      input.referenceVideoUrls.length > 0) ||
    (input.referenceAudioUrls !== undefined &&
      input.referenceAudioUrls.length > 0)
  );
}

/**
 * Validate a Seedance 2.0 Mini request against the live Kie schema.
 *
 * Enforces the three mutually exclusive modes (spec §26.3): first-frame I2V,
 * first+last-frame I2V, and multimodal-reference can never be combined.
 */
export function validateSeedanceRequest(
  input: SeedanceInput,
): SeedanceValidationResult {
  const errors: SeedanceValidationError[] = [];

  // --- prompt -------------------------------------------------------------
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    errors.push({ field: "input.prompt", message: "prompt is required" });
  } else if (input.prompt.length < SEEDANCE_2_MINI_LIMITS.promptLength.value.min) {
    errors.push({
      field: "input.prompt",
      message: `prompt must be at least ${SEEDANCE_2_MINI_LIMITS.promptLength.value.min} characters`,
    });
  } else if (input.prompt.length > SEEDANCE_2_MINI_LIMITS.promptLength.value.max) {
    errors.push({
      field: "input.prompt",
      message: `prompt exceeds the verified maximum of ${SEEDANCE_2_MINI_LIMITS.promptLength.value.max} characters`,
    });
  }

  // --- resolution / aspect ratio enums -------------------------------------
  if (
    input.resolution !== undefined &&
    !SEEDANCE_2_MINI_LIMITS.resolution.value.includes(input.resolution)
  ) {
    errors.push({
      field: "input.resolution",
      message: `resolution must be one of ${SEEDANCE_2_MINI_LIMITS.resolution.value.join(", ")}`,
    });
  }
  if (
    input.aspectRatio !== undefined &&
    !SEEDANCE_2_MINI_LIMITS.aspectRatio.value.includes(input.aspectRatio)
  ) {
    errors.push({
      field: "input.aspect_ratio",
      message: `aspect_ratio must be one of ${SEEDANCE_2_MINI_LIMITS.aspectRatio.value.join(", ")}`,
    });
  }

  // --- duration (PROVISIONAL bounds from the doc description) --------------
  if (input.duration !== undefined) {
    if (!Number.isInteger(input.duration)) {
      errors.push({
        field: "input.duration",
        message: "duration must be an integer number of seconds",
      });
    } else {
      const { min, max } = SEEDANCE_2_MINI_LIMITS.durationSeconds.value;
      if (input.duration < min || input.duration > max) {
        errors.push({
          field: "input.duration",
          message: `duration must be ${min}-${max} seconds (doc description; schema states no numeric bounds — PROVISIONAL)`,
        });
      }
    }
  }

  // --- mode exclusivity (spec §26.3: never combine modes) -------------------
  const hasFirst = input.firstFrameUrl !== undefined;
  const hasLast = input.lastFrameUrl !== undefined;
  const hasRefs = hasReferenceInputs(input);

  if (hasLast && !hasFirst) {
    errors.push({
      field: "input.last_frame_url",
      message: "last_frame_url requires first_frame_url (first+last I2V mode)",
    });
  }
  if (hasRefs && (hasFirst || hasLast)) {
    errors.push({
      field: "input",
      message:
        "mutually exclusive modes: multimodal-reference inputs (reference_image_urls/reference_video_urls/reference_audio_urls) cannot be combined with first_frame_url/last_frame_url",
    });
  }

  // --- reference arrays ------------------------------------------------------
  if (input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined) {
    for (const [field, url] of [
      ["first_frame_url", input.firstFrameUrl],
      ["last_frame_url", input.lastFrameUrl],
    ] as const) {
      if (url !== undefined && !isHttpUrl(url) && !isAssetRef(url)) {
        errors.push({
          field: `input.${field}`,
          message: "must be an https URL or an asset://{assetId} reference",
        });
      }
    }
  }
  const imgMax = SEEDANCE_2_MINI_LIMITS.referenceImages.value.maxCount;
  if (
    input.referenceImageUrls !== undefined &&
    input.referenceImageUrls.length > imgMax
  ) {
    errors.push({
      field: "input.reference_image_urls",
      message: `at most ${imgMax} reference images`,
    });
  }
  const vidMax = SEEDANCE_2_MINI_LIMITS.referenceVideos.value.maxCount;
  if (
    input.referenceVideoUrls !== undefined &&
    input.referenceVideoUrls.length > vidMax
  ) {
    errors.push({
      field: "input.reference_video_urls",
      message: `at most ${vidMax} reference videos`,
    });
  }
  const audMax = SEEDANCE_2_MINI_LIMITS.referenceAudios.value.maxCount;
  if (
    input.referenceAudioUrls !== undefined &&
    input.referenceAudioUrls.length > audMax
  ) {
    errors.push({
      field: "input.reference_audio_urls",
      message: `at most ${audMax} reference audios`,
    });
  }

  const ok = errors.length === 0;
  return {
    ok,
    mode: ok ? generationMode(input) : undefined,
    errors,
  };
}

/** Build the exact createTask request body for the validated input. */
export function buildSeedanceRequest(
  input: SeedanceInput,
): SeedanceRequest {
  const body: SeedanceRequest = {
    model: SEEDANCE_2_MINI_MODEL,
    input: {
      prompt: input.prompt,
    },
  };
  if (input.firstFrameUrl !== undefined)
    body.input.first_frame_url = input.firstFrameUrl;
  if (input.lastFrameUrl !== undefined)
    body.input.last_frame_url = input.lastFrameUrl;
  if (input.referenceImageUrls !== undefined)
    body.input.reference_image_urls = [...input.referenceImageUrls];
  if (input.referenceVideoUrls !== undefined)
    body.input.reference_video_urls = [...input.referenceVideoUrls];
  if (input.referenceAudioUrls !== undefined)
    body.input.reference_audio_urls = [...input.referenceAudioUrls];
  if (input.generateAudio !== undefined)
    body.input.generate_audio = input.generateAudio;
  if (input.resolution !== undefined) body.input.resolution = input.resolution;
  if (input.aspectRatio !== undefined)
    body.input.aspect_ratio = input.aspectRatio;
  if (input.duration !== undefined) body.input.duration = input.duration;
  if (input.webSearch !== undefined) body.input.web_search = input.webSearch;
  if (input.nsfwChecker !== undefined)
    body.input.nsfw_checker = input.nsfwChecker;
  if (input.callbackUrl !== undefined) body.callBackUrl = input.callbackUrl;
  return body;
}

/** Submit endpoint (Kie jobs API). */
export const SEEDANCE_CREATE_TASK_URL = `${KIE_API_BASE}/api/v1/jobs/createTask`;

/** Poll endpoint (Kie jobs API) — taskId passed as a query parameter. */
export function seedanceRecordInfoUrl(taskId: string): string {
  return `${KIE_API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
}