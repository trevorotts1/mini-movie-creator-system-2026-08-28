/**
 * Wan 3.0 capability profile — LIVE-VERIFIED capability registry data.
 *
 * Sources (fetched 2026-08-28, HTTP 200):
 *   - https://docs.kie.ai/market/wan/3-0-video.md          (OpenAPI schema: limits, enums, defaults)
 *   - https://docs.kie.ai/market/wan/3-0-video-prime.md    (prime variant schema)
 *   - https://docs.kie.ai/market/common/get-task-detail.md  (unified recordInfo states/result shape)
 *   - https://kie.ai/wan3.0-video (+ -prime)                (pricing in credits/second)
 *
 * Baseline from the build spec (runbook §26.4): 20,000-char prompt, ≤10 ref
 * images, ≤5 ref videos, ≤5 ref audio, ≤30s, 480p/720p/1080p — VERIFIED below;
 * where live docs were richer, live values win (spec: never trust the static
 * doc over newer official documentation).
 */

import type { WanAspectRatio, WanResolution } from "./types.js";

/** Model slugs (verified 2026-08-28; createTask `model` field enum). */
export const WAN_3_0_MODEL = "wan/3-0-video" as const;
export const WAN_3_0_PRIME_MODEL = "wan/3-0-video-prime" as const;
export type WanModelId = typeof WAN_3_0_MODEL | typeof WAN_3_0_PRIME_MODEL;

/** Verified capability record for one Wan 3.0 model id. */
export interface WanCapability {
  provider: "kie";
  modelId: WanModelId;
  kind: "video";
  /** Date the values below were verified against live provider docs. */
  lastVerifiedAt: "2026-08-28";
  sourceUrls: string[];
  /** All limits below were read from the provider's current OpenAPI schema. */
  confidence: "VERIFIED";
  prompt: {
    /** Server truncates >20,000; MMCS validates BEFORE submit (no silent loss). */
    hardMaxCharacters: number;
    recommendedMaxCharacters: number;
    negativePrompt: boolean;
  };
  references: {
    maxImages: number;
    maxVideos: number;
    maxAudio: number;
    /** File-to-video (≤1 doc) and link-to-video (≤1 url) also exist. */
    maxFiles: number;
    maxLinks: number;
    firstFrame: boolean;
    lastFrame: boolean;
    firstLastFrame: boolean;
    multimodalReferences: boolean;
    /**
     * Mutually exclusive input groups (verified doc text):
     *  - first_frame_url/last_frame_url vs any reference_*_urls
     *  - reference_file_urls vs reference_link_urls
     */
    incompatibleCombinations: string[];
  };
  output: {
    minDurationSeconds: number;
    maxDurationSeconds: number;
    /** -1 allowed = model-chosen "intelligent" duration. */
    allowsSentinelDuration: boolean;
    /** Default when omitted. */
    defaultDurationSeconds: number;
    resolutions: WanResolution[];
    defaultResolution: WanResolution;
    aspectRatios: WanAspectRatio[];
    defaultAspectRatio: WanAspectRatio;
    /** Output audio track toggle; default true. */
    audioToggle: boolean;
  };
  referenceMediaConstraints: {
    image: { formats: readonly string[]; maxSidePx: number; minSidePx: number; maxAspectRatio: number; maxBytes: number };
    video: { formats: readonly string[]; clipMinSeconds: number; clipMaxSeconds: number; totalMaxSeconds: number; minSidePx: number; maxSidePx: number; maxBytesEach: number };
    audio: { formats: readonly string[]; clipMinSeconds: number; clipMaxSeconds: number; totalMaxSeconds: number; maxBytesEach: number };
    file: { formats: readonly string[]; maxBytes: number; maxPages: number };
  };
  pricing: {
    unit: string;
    currency: string;
    /** Effective dollar rate per output second (Kie credit = $0.005). */
    usdPerSecondByResolution: Record<"480P" | "720P" | "1080P", number>;
    creditsPerSecondByResolution: Record<"480P" | "720P" | "1080P", number>;
    /** With reference videos, billing = (input video duration + output duration) × rate. */
    billedOnInputVideoSecondsToo: boolean;
  };
  /** Doc-noted behavior: URLs expire ~24h after completion. */
  resultUrlTtlHours: number;
}

const IMAGE_CONSTRAINTS = {
  formats: ["JPEG", "JPG", "PNG", "BMP", "WEBP"],
  maxSidePx: 8000,
  minSidePx: 240,
  maxAspectRatio: 8,
  maxBytes: 20 * 1024 * 1024,
} as const;

const VIDEO_CONSTRAINTS = {
  formats: ["mp4", "mov"],
  clipMinSeconds: 1,
  clipMaxSeconds: 15,
  totalMaxSeconds: 15,
  minSidePx: 240,
  maxSidePx: 4096,
  maxBytesEach: 100 * 1024 * 1024,
} as const;

const AUDIO_CONSTRAINTS = {
  formats: ["wav", "mp3"],
  clipMinSeconds: 1,
  clipMaxSeconds: 15,
  totalMaxSeconds: 15,
  maxBytesEach: 15 * 1024 * 1024,
} as const;

const FILE_CONSTRAINTS = {
  formats: ["docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "txt", "key", "pages", "numbers", "md"],
  maxBytes: 100 * 1024 * 1024,
  maxPages: 50,
} as const;

/** The standard Wan 3.0 model (slower, higher quality). */
export const WAN_3_0_VIDEO: WanCapability = Object.freeze<WanCapability>({
  provider: "kie",
  modelId: WAN_3_0_MODEL,
  kind: "video",
  lastVerifiedAt: "2026-08-28",
  sourceUrls: [
    "https://docs.kie.ai/market/wan/3-0-video.md",
    "https://docs.kie.ai/market/common/get-task-detail.md",
    "https://kie.ai/wan3.0-video",
  ],
  confidence: "VERIFIED",
  prompt: { hardMaxCharacters: 20_000, recommendedMaxCharacters: 20_000, negativePrompt: false },
  references: {
    maxImages: 10,
    maxVideos: 5,
    maxAudio: 5,
    maxFiles: 1,
    maxLinks: 1,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    incompatibleCombinations: [
      "first_frame_url+reference_*_urls",
      "last_frame_url+reference_*_urls",
      "reference_file_urls+reference_link_urls",
    ],
  },
  output: {
    minDurationSeconds: 2,
    maxDurationSeconds: 30,
    allowsSentinelDuration: true,
    defaultDurationSeconds: 5,
    resolutions: ["480P", "720P", "1080P"],
    defaultResolution: "1080P",
    aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultAspectRatio: "adaptive",
    audioToggle: true,
  },
  referenceMediaConstraints: { image: IMAGE_CONSTRAINTS, video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS, file: FILE_CONSTRAINTS },
  pricing: {
    unit: "credits-per-second-by-resolution",
    currency: "USD",
    usdPerSecondByResolution: { "480P": 0.04, "720P": 0.08, "1080P": 0.16 },
    creditsPerSecondByResolution: { "480P": 8, "720P": 16, "1080P": 32 },
    billedOnInputVideoSecondsToo: true,
  },
  resultUrlTtlHours: 24,
});

/** The prime (high-speed) variant — same limits, ~26% cheaper effective rate. */
export const WAN_3_0_VIDEO_PRIME: WanCapability = Object.freeze({
  ...WAN_3_0_VIDEO,
  modelId: WAN_3_0_PRIME_MODEL,
  sourceUrls: [
    "https://docs.kie.ai/market/wan/3-0-video-prime.md",
    "https://docs.kie.ai/market/common/get-task-detail.md",
    "https://kie.ai/wan3.0-video-prime",
  ],
  pricing: {
    unit: "credits-per-second-by-resolution",
    currency: "USD",
    usdPerSecondByResolution: { "480P": 0.0612, "720P": 0.126, "1080P": 0.252 },
    creditsPerSecondByResolution: { "480P": 12.2, "720P": 25.2, "1080P": 50.4 },
    billedOnInputVideoSecondsToo: true,
  },
});

/** All verified Wan 3.0 profiles, keyed by model id. */
export const WAN_PROFILES: Readonly<Record<WanModelId, WanCapability>> = Object.freeze({
  [WAN_3_0_MODEL]: WAN_3_0_VIDEO,
  [WAN_3_0_PRIME_MODEL]: WAN_3_0_VIDEO_PRIME,
});

/** Look up a verified profile by model id. */
export function getWanProfile(model: WanModelId = WAN_3_0_MODEL): WanCapability {
  return WAN_PROFILES[model];
}

/** True when the model id is a verified Wan 3.0 slug. */
export function isWanModel(model: string): model is WanModelId {
  return model === WAN_3_0_MODEL || model === WAN_3_0_PRIME_MODEL;
}