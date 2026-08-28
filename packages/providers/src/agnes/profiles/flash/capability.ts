/**
 * Agnes Video 2.5 Flash capability profile (@mmcs/providers/agnes/profiles/flash).
 *
 * Task AGN-006. Live-verified against the official Agnes AI docs on
 * 2026-08-28 (all URLs fetched HTTP 200 that day):
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash  (Flash schema)
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25        (common rules)
 *   - https://wiki.agnes-ai.com/en/docs/pricing.md            (pricing)
 *
 * BINDING rules encoded here (runbook §25/§26.1):
 *   - The hard prompt character ceiling is NOT documented anywhere → UNKNOWN
 *     (null). Never copy another model's limit onto Agnes. A test asserts the
 *     UNKNOWN survives and that validation does not enforce any ceiling.
 *   - The model identifier is RUNTIME-DISCOVERED from current docs, never
 *     hard-coded from stale `agnes-video-v2.0` public docs (runbook §11.1:
 *     "record runtime-discovered 2.5 IDs with source/date").
 *   - Flash is valid FINAL footage when it passes QC — never auto-discarded
 *     as preview-only.
 */

/** Exact model identifier accepted by the Agnes create endpoint. */
export const AGNES_FLASH_MODEL = "agnes-video-2.5-flash" as const;
export type AgnesFlashModelId = typeof AGNES_FLASH_MODEL;

/** Provenance for the runtime-discovered model ID (runbook §11.1). */
export const AGNES_FLASH_MODEL_DISCOVERY: Readonly<{
  modelId: AgnesFlashModelId;
  discoveredVia: string;
  sourceUrl: string;
  verifiedOn: "2026-08-28";
  /** Stale identifier that must never be used. */
  staleModelId: "agnes-video-v2.0";
}> = Object.freeze({
  modelId: AGNES_FLASH_MODEL,
  discoveredVia: "live official Agnes docs fetch (HTTP 200)",
  sourceUrl: "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash",
  verifiedOn: "2026-08-28",
  staleModelId: "agnes-video-v2.0",
});

/** Agnes API base (OpenAI-compatible). */
export const AGNES_API_BASE = "https://apihub.agnes-ai.com/v1";

/** Video creation endpoint: POST {AGNES_API_BASE}/videos. */
export const AGNES_VIDEOS_URL = `${AGNES_API_BASE}/videos`;

/** Retrieve host root (the /agnesapi route is NOT under /v1). */
export const AGNES_RETRIEVE_BASE = "https://apihub.agnes-ai.com/agnesapi";

/** The three mutually exclusive generation modes (exact Agnes strings). */
export type AgnesFlashMode = "text" | "keyframe" | "reference";

/** Aspect ratios accepted by Flash, with the documented pixel output. */
export const AGNES_FLASH_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
export type AgnesFlashAspectRatio = (typeof AGNES_FLASH_ASPECT_RATIOS)[number];

/** aspect_ratio → output pixels (doc table, Flash is 720P-only). */
export const AGNES_FLASH_ASPECT_RATIO_PIXELS: Readonly<
  Record<AgnesFlashAspectRatio, { width: number; height: number }>
> = Object.freeze({
  "21:9": { width: 1680, height: 720 },
  "16:9": { width: 1280, height: 720 },
  "4:3": { width: 960, height: 720 },
  "1:1": { width: 720, height: 720 },
  "3:4": { width: 720, height: 960 },
  "9:16": { width: 720, height: 1280 },
});

/** A capability limit whose value the live Agnes docs do NOT state. */
export interface UnknownLimit {
  readonly status: "UNKNOWN";
  /** Why the value is unknown — where verification was attempted. */
  readonly note: string;
}

/** A capability limit stated by the live Agnes docs. */
export interface VerifiedLimit<T> {
  readonly status: "VERIFIED";
  /** Agnes doc URL the value was read from. */
  readonly source: string;
  /** Date the doc was verified, ISO YYYY-MM-DD. */
  readonly verifiedOn: string;
  readonly value: T;
}

/** Either a verified value or an explicit UNKNOWN. */
export type Limit<T> = VerifiedLimit<T> | UnknownLimit;

const FLASH_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash";
const COMMON_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-video-25";
const PRICING_DOC = "https://wiki.agnes-ai.com/en/docs/pricing";
const VERIFIED_ON = "2026-08-28";

/** Numeric limits exactly as stated by the live Agnes docs (2026-08-28). */
export const AGNES_FLASH_LIMITS: Readonly<{
  /**
   * Hard prompt character ceiling: NOT STATED on any Agnes page → UNKNOWN.
   * Validators must not enforce a limit against UNKNOWN (runbook §25).
   */
  promptLength: UnknownLimit;
  /** `seconds` is a string "4"–"12", default "5". */
  durationSeconds: VerifiedLimit<{ min: number; max: number }>;
  defaultDurationSeconds: VerifiedLimit<number>;
  /** `size` fixed "720P"; other values → HTTP 400 "size must be 720P". */
  size: VerifiedLimit<readonly ["720P"]>;
  aspectRatios: VerifiedLimit<readonly AgnesFlashAspectRatio[]>;
  defaultAspectRatio: VerifiedLimit<AgnesFlashAspectRatio>;
  /** `images length must not exceed 5` (HTTP 400). */
  maxReferenceImages: VerifiedLimit<number>;
  /** Non-empty `videos` always rejected (HTTP 400 "videos is not supported"). */
  referenceVideos: VerifiedLimit<{ supported: false }>;
  /** Audios accepted per Video 2.5 common rules; max count not stated. */
  maxReferenceAudios: UnknownLimit;
  /** Keyframe mode: at least one of first_frame / last_frame required. */
  firstFrame: VerifiedLimit<boolean>;
  lastFrame: VerifiedLimit<boolean>;
  /** `n` = 1 only. */
  outputs: VerifiedLimit<1>;
  /** `seed` integer supported. */
  seed: VerifiedLimit<boolean>;
  /** List price per output second at 720P; currently $0 promo. */
  listUsdPerSecond720P: VerifiedLimit<number>;
  /** Input images beyond the 5 free ones. */
  excessInputImageUsd: VerifiedLimit<number>;
}> = {
  promptLength: {
    status: "UNKNOWN",
    note: `No prompt character limit stated on ${FLASH_DOC} or ${COMMON_DOC} (both fetched 2026-08-28). Preserved UNKNOWN — runbook §26.1 forbids inventing an Agnes ceiling.`,
  },
  durationSeconds: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: { min: 4, max: 12 },
  },
  defaultDurationSeconds: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: 5,
  },
  size: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: ["720P"] as const,
  },
  aspectRatios: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: AGNES_FLASH_ASPECT_RATIOS,
  },
  defaultAspectRatio: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: "16:9",
  },
  maxReferenceImages: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: 5,
  },
  referenceVideos: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: { supported: false as const },
  },
  maxReferenceAudios: {
    status: "UNKNOWN",
    note: `${COMMON_DOC} documents audios[] for reference mode but states no max count; the Flash page defers to those common rules (checked 2026-08-28). Preserved UNKNOWN.`,
  },
  firstFrame: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  lastFrame: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  outputs: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: 1 as const,
  },
  seed: {
    status: "VERIFIED",
    source: FLASH_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  listUsdPerSecond720P: {
    status: "VERIFIED",
    source: PRICING_DOC,
    verifiedOn: VERIFIED_ON,
    value: 0.025,
  },
  excessInputImageUsd: {
    status: "VERIFIED",
    source: PRICING_DOC,
    verifiedOn: VERIFIED_ON,
    value: 0.005,
  },
};

/**
 * Full capability record for Agnes Video 2.5 Flash — mirrors the registry
 * seed (packages/capability-registry/src/data/agnes.ts →
 * AGNES_VIDEO_2_5_FLASH) at the provider-adapter layer.
 */
export interface AgnesFlashCapability {
  provider: "agnes";
  modelId: AgnesFlashModelId;
  kind: "video";
  /** Date the values below were verified against live provider docs. */
  lastVerifiedAt: "2026-08-28";
  sourceUrls: readonly string[];
  confidence: "VERIFIED";
  prompt: {
    /** null = UNKNOWN (undocumented) — never enforce, never invent. */
    hardMaxCharacters: null;
    recommendedMaxCharacters: null;
    /** Negative prompt not documented → UNKNOWN. */
    negativePrompt: null;
  };
  references: {
    maxImages: 5;
    /** Unsupported outright — any non-empty array is an HTTP 400. */
    videosSupported: false;
    maxVideos: null;
    maxAudio: null;
    firstFrame: true;
    lastFrame: true;
    firstLastFrame: true;
    multimodalReferences: true;
    incompatibleCombinations: readonly string[];
  };
  output: {
    minDurationSeconds: 4;
    maxDurationSeconds: 12;
    resolutions: readonly ["720P"];
    aspectRatios: readonly AgnesFlashAspectRatio[];
  };
  pricing: {
    unit: "usd-per-output-second-720p";
    amount: number;
    currency: "USD";
    /** Currently $0 (limited-time promotion); list rate kept for estimates. */
    currentPromotionalUsdPerSecond: number;
  };
  /** Flash passes QC ⇒ final footage; never preview-only (runbook §26.1). */
  validFinalFootage: true;
}

/** The verified Flash capability record. */
export const AGNES_VIDEO_2_5_FLASH: AgnesFlashCapability = Object.freeze<AgnesFlashCapability>({
  provider: "agnes",
  modelId: AGNES_FLASH_MODEL,
  kind: "video",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [FLASH_DOC, COMMON_DOC, PRICING_DOC],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    negativePrompt: null,
  },
  references: {
    maxImages: 5,
    videosSupported: false,
    maxVideos: null,
    maxAudio: null,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    incompatibleCombinations: [
      "mode=keyframe excludes images/audios/videos",
      "mode=reference excludes first_frame/last_frame/videos",
      "mode=text excludes first_frame/last_frame/images/audios/videos",
      "non-empty videos always rejected (HTTP 400: videos is not supported)",
    ],
  },
  output: {
    minDurationSeconds: 4,
    maxDurationSeconds: 12,
    resolutions: ["720P"] as const,
    aspectRatios: AGNES_FLASH_ASPECT_RATIOS,
  },
  pricing: {
    unit: "usd-per-output-second-720p",
    amount: 0.025,
    currency: "USD",
    currentPromotionalUsdPerSecond: 0,
  },
  validFinalFootage: true,
});

/**
 * Build the async retrieval URL. Flash keyframe/reference tasks REQUIRE
 * `model_name` on retrieval; `mode: "text"` also works bare, and passing
 * model_name is recommended for all modes — so it is always included.
 */
export function agnesFlashRetrieveUrl(videoId: string): string {
  return `${AGNES_RETRIEVE_BASE}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(AGNES_FLASH_MODEL)}`;
}