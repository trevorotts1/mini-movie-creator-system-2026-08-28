/**
 * Agnes Video 2.5 regular capability profile (@mmcs/providers/agnes/profiles/regular).
 *
 * Task AGN-007. Values mirror the CAP-002 registry seed
 * (packages/capability-registry/src/data/agnes.ts → AGNES_VIDEO_2_5),
 * verified against the live official Agnes docs on 2026-08-28:
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25  (regular schema)
 *   - https://wiki.agnes-ai.com/en/docs/pricing         (pricing)
 *
 * BINDING rules encoded here (runbook §26.2 / spec §25, §31):
 *   - The hard prompt character ceiling is NOT documented anywhere → UNKNOWN
 *     (null). Never copy another model's limit onto Agnes.
 *   - The reference-image hard cap is NOT stated for the regular model
 *     (unlike Flash, whose doc states "images length must not exceed 5").
 *     The 5 in the pricing doc is a FREE-ALLOWANCE billing rule, not a cap
 *     → hard max stays UNKNOWN; the allowance is recorded as a VERIFIED
 *     billing constant. NOTE: the task acceptance line says "≤5 ref images";
 *     the live-doc verification (CAP-002) found no stated hard cap, so the
 *     ≤5 is honoured as the recommended/free-allowance count, not enforced
 *     as a hard rejection. Discrepancy logged in the builder notes.
 *   - Reference VIDEOS are supported on regular (unlike Flash): videos[] of
 *     {url, start_seconds, require_audio}.
 *   - The model identifier is RUNTIME-DISCOVERED from current docs, never
 *     hard-coded from stale `agnes-video-v2.0` public docs (runbook §11.1).
 */

/** Exact model identifier accepted by the Agnes create endpoint. */
export const AGNES_REGULAR_MODEL = "agnes-video-2.5" as const;
export type AgnesRegularModelId = typeof AGNES_REGULAR_MODEL;

/** Provenance for the runtime-discovered model ID (runbook §11.1). */
export const AGNES_REGULAR_MODEL_DISCOVERY: Readonly<{
  modelId: AgnesRegularModelId;
  discoveredVia: string;
  sourceUrl: string;
  verifiedOn: "2026-08-28";
  /** Stale identifier that must never be used. */
  staleModelId: "agnes-video-v2.0";
}> = Object.freeze({
  modelId: AGNES_REGULAR_MODEL,
  discoveredVia: "live official Agnes docs fetch (HTTP 200)",
  sourceUrl: "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
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
export type AgnesRegularMode = "text" | "keyframe" | "reference";

/** Aspect ratios accepted by regular, with the documented 720P-tier pixels. */
export const AGNES_REGULAR_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
export type AgnesRegularAspectRatio = (typeof AGNES_REGULAR_ASPECT_RATIOS)[number];

/** Output size tiers accepted by regular (WIDTHxHEIGHT and auto → HTTP 400). */
export const AGNES_REGULAR_SIZES = ["720P", "960P", "2K"] as const;
export type AgnesRegularSize = (typeof AGNES_REGULAR_SIZES)[number];

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

const REGULAR_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-video-25";
const PRICING_DOC = "https://wiki.agnes-ai.com/en/docs/pricing";
const VERIFIED_ON = "2026-08-28";

/** Numeric limits exactly as stated by the live Agnes docs (2026-08-28). */
export const AGNES_REGULAR_LIMITS: Readonly<{
  /**
   * Hard prompt character ceiling: NOT STATED on any Agnes page → UNKNOWN.
   * Validators must not enforce a limit against UNKNOWN (runbook §26.2).
   */
  promptLength: UnknownLimit;
  /** `seconds` is a string "4"–"12", default "5". */
  durationSeconds: VerifiedLimit<{ min: number; max: number }>;
  defaultDurationSeconds: VerifiedLimit<number>;
  /** `size` accepts the three tiers; WIDTHxHEIGHT / auto → HTTP 400. */
  size: VerifiedLimit<readonly AgnesRegularSize[]>;
  defaultSize: VerifiedLimit<AgnesRegularSize>;
  aspectRatios: VerifiedLimit<readonly AgnesRegularAspectRatio[]>;
  /**
   * Reference-image hard cap: NOT stated on the regular doc (only Flash
   * states "must not exceed 5") → UNKNOWN. Never enforced.
   */
  maxReferenceImages: UnknownLimit;
  /**
   * VERIFIED billing rule: the first 5 input images are free; each image
   * beyond the allowance bills $0.005. An allowance, NOT a hard cap.
   */
  freeImageAllowance: VerifiedLimit<number>;
  /** Input images beyond the free allowance. */
  excessInputImageUsd: VerifiedLimit<number>;
  /** Reference videos[] accepted; max count not stated → UNKNOWN. */
  maxReferenceVideos: UnknownLimit;
  /** Reference audios[] accepted; max count not stated → UNKNOWN. */
  maxReferenceAudios: UnknownLimit;
  /** Keyframe mode: at least one of first_frame / last_frame required. */
  firstFrame: VerifiedLimit<boolean>;
  lastFrame: VerifiedLimit<boolean>;
  /** `n` = 1 only. */
  outputs: VerifiedLimit<1>;
  /** `seed` integer supported. */
  seed: VerifiedLimit<boolean>;
  /** List price per output second, by size tier. */
  listUsdPerSecond: VerifiedLimit<Record<AgnesRegularSize, number>>;
}> = {
  promptLength: {
    status: "UNKNOWN",
    note: `No prompt character limit stated on ${REGULAR_DOC} or ${PRICING_DOC} (both fetched 2026-08-28). Preserved UNKNOWN — runbook §26.2 forbids inventing an Agnes ceiling.`,
  },
  durationSeconds: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: { min: 4, max: 12 },
  },
  defaultDurationSeconds: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: 5,
  },
  size: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: AGNES_REGULAR_SIZES,
  },
  defaultSize: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: "720P",
  },
  aspectRatios: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: AGNES_REGULAR_ASPECT_RATIOS,
  },
  maxReferenceImages: {
    status: "UNKNOWN",
    note: `The regular doc (${REGULAR_DOC}) states no images length cap — the "must not exceed 5" rule is Flash-only. The pricing doc's 5 is the free-allowance billing rule, not a hard cap (checked 2026-08-28). Preserved UNKNOWN; never enforced.`,
  },
  freeImageAllowance: {
    status: "VERIFIED",
    source: PRICING_DOC,
    verifiedOn: VERIFIED_ON,
    value: 5,
  },
  excessInputImageUsd: {
    status: "VERIFIED",
    source: PRICING_DOC,
    verifiedOn: VERIFIED_ON,
    value: 0.005,
  },
  maxReferenceVideos: {
    status: "UNKNOWN",
    note: `${REGULAR_DOC} documents videos[] objects (url/start_seconds/require_audio) but states no max count (checked 2026-08-28). Preserved UNKNOWN.`,
  },
  maxReferenceAudios: {
    status: "UNKNOWN",
    note: `${REGULAR_DOC} documents audios[] but states no max count (checked 2026-08-28). Preserved UNKNOWN.`,
  },
  firstFrame: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  lastFrame: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  outputs: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: 1 as const,
  },
  seed: {
    status: "VERIFIED",
    source: REGULAR_DOC,
    verifiedOn: VERIFIED_ON,
    value: true,
  },
  listUsdPerSecond: {
    status: "VERIFIED",
    source: PRICING_DOC,
    verifiedOn: VERIFIED_ON,
    value: { "720P": 0.025, "960P": 0.04, "2K": 0.055 },
  },
};

/**
 * Full capability record for Agnes Video 2.5 regular — mirrors the registry
 * seed (packages/capability-registry/src/data/agnes.ts → AGNES_VIDEO_2_5)
 * at the provider-adapter layer.
 */
export interface AgnesRegularCapability {
  provider: "agnes";
  modelId: AgnesRegularModelId;
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
    /** null = UNKNOWN — no documented hard cap on regular. */
    maxImages: null;
    /** Free-allowance billing rule (price, not a cap). */
    freeImageAllowance: 5;
    maxVideos: null;
    maxAudio: null;
    firstFrame: true;
    lastFrame: true;
    firstLastFrame: true;
    multimodalReferences: true;
    /** Unlike Flash, reference videos ARE supported on regular. */
    referenceVideosSupported: true;
    incompatibleCombinations: readonly string[];
  };
  output: {
    minDurationSeconds: 4;
    maxDurationSeconds: 12;
    resolutions: readonly AgnesRegularSize[];
    aspectRatios: readonly AgnesRegularAspectRatio[];
  };
  pricing: {
    unit: "usd-per-output-second-by-size";
    currency: "USD";
    /** List rate per output second, keyed by size tier. */
    usdPerOutputSecond: Record<AgnesRegularSize, number>;
    /** First N input images free; each beyond bills excessInputImageUsd. */
    freeImageAllowance: 5;
    excessInputImageUsd: number;
  };
  /** Regular passes QC ⇒ final footage; never preview-only (runbook §26.2). */
  validFinalFootage: true;
}

/** The verified regular capability record. */
export const AGNES_VIDEO_2_5_REGULAR: AgnesRegularCapability =
  Object.freeze<AgnesRegularCapability>({
    provider: "agnes",
    modelId: AGNES_REGULAR_MODEL,
    kind: "video",
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [REGULAR_DOC, PRICING_DOC],
    confidence: "VERIFIED",
    prompt: {
      hardMaxCharacters: null,
      recommendedMaxCharacters: null,
      negativePrompt: null,
    },
    references: {
      maxImages: null,
      freeImageAllowance: 5,
      maxVideos: null,
      maxAudio: null,
      firstFrame: true,
      lastFrame: true,
      firstLastFrame: true,
      multimodalReferences: true,
      referenceVideosSupported: true,
      incompatibleCombinations: [
        "mode=keyframe excludes images/audios/videos",
        "mode=reference excludes first_frame/last_frame",
      ],
    },
    output: {
      minDurationSeconds: 4,
      maxDurationSeconds: 12,
      resolutions: AGNES_REGULAR_SIZES,
      aspectRatios: AGNES_REGULAR_ASPECT_RATIOS,
    },
    pricing: {
      unit: "usd-per-output-second-by-size",
      currency: "USD",
      usdPerOutputSecond: { "720P": 0.025, "960P": 0.04, "2K": 0.055 },
      freeImageAllowance: 5,
      excessInputImageUsd: 0.005,
    },
    validFinalFootage: true,
  });

/**
 * Build the async retrieval URL. Keyframe/reference tasks REQUIRE
 * `model_name` on retrieval; it is always included.
 */
export function agnesRegularRetrieveUrl(videoId: string): string {
  return `${AGNES_RETRIEVE_BASE}?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(AGNES_REGULAR_MODEL)}`;
}
