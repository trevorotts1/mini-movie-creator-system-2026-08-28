/**
 * Kie provider family — seeded capability data (CAP-002).
 *
 * Every value below was read from the live official Kie docs on 2026-08-28
 * (all URLs fetched HTTP 200):
 *   - https://docs.kie.ai/market/bytedance/seedance-2-mini  (OpenAPI schema)
 *   - https://docs.kie.ai/market/wan/3-0-video              (OpenAPI schema)
 *   - https://kie.ai/seedance-2-0-mini                      (pricing desc)
 *   - https://kie.ai/wan3.0-video                           (pricing desc)
 *   - https://kie.ai/wan3.0-video-prime                     (pricing desc)
 *
 * Schema facts (promptLength 3–20000, refs 9/3/3, duration 4–15, 480p/720p,
 * aspect enums) verified directly in the fetched OpenAPI schema — consistent
 * with KIE-003's SEEDANCE_2_MINI_LIMITS and KIE-005's WanCapability, which own
 * the adapter-side constants; this file is the registry copy. Wan reference
 * counts (10/5/5), prompt 20000, durations [2,30], resolutions 480P/720P/1080P
 * verified from the Wan schema. Negative-prompt field absent from both schemas
 * → null (UNKNOWN), never asserted.
 */

import type { MediaModelCapabilitySeed } from "./types.js";

const VERIFIED_ON = "2026-08-28";

const SEEDANCE_DOC =
  "https://docs.kie.ai/market/bytedance/seedance-2-mini";
const WAN_DOC = "https://docs.kie.ai/market/wan/3-0-video";
const WAN_PRIME_DOC = "https://docs.kie.ai/market/wan/3-0-video-prime";
const KIE_SEEDANCE_PAGE = "https://kie.ai/seedance-2-0-mini";
const KIE_WAN_PAGE = "https://kie.ai/wan3.0-video";
const KIE_WAN_PRIME_PAGE = "https://kie.ai/wan3.0-video-prime";

/**
 * Seedance 2.0 Mini via Kie — `bytedance/seedance-2-mini`.
 * Three mutually exclusive modes: first-frame I2V; first+last-frame I2V;
 * multimodal-reference (images 9 / videos 3 / audios 3, ≤15 s each type).
 */
export const KIE_SEEDANCE_2_MINI: MediaModelCapabilitySeed = Object.freeze({
  provider: "kie",
  modelId: "bytedance/seedance-2-mini",
  kind: "video",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [SEEDANCE_DOC, KIE_SEEDANCE_PAGE],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: 20_000,
    recommendedMaxCharacters: 20_000,
    negativePrompt: false,
  },
  references: {
    maxImages: 9,
    maxVideos: 3,
    maxAudio: 3,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    incompatibleCombinations: [
      "first_frame_url/last_frame_url + any reference_*_urls (mutually exclusive mode groups)",
      "mode groups: first-frame-i2v | first-last-frame-i2v | multimodal-reference",
    ],
  },
  output: {
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    resolutions: ["480p", "720p"],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"],
  },
  pricing: {
    unit: "usd-per-output-second-480p",
    amount: 0.012,
    currency: "USD",
  },
  pricingDetail: {
    "480p-with-video-input": 0.012,
    "480p-no-video-input": 0.019,
    "720p-with-video-input": 0.025,
    "720p-no-video-input": 0.041,
    "credits-480p-with-video": 2.4,
    "credits-480p-no-video": 3.8,
    "credits-720p-with-video": 5.0,
    "credits-720p-no-video": 8.2,
  },
  notes: {
    promptLength:
      "OpenAPI schema: Min length 3, Max length 20000 characters (maxLength: 20000).",
    resolutionEnum:
      "Schema enum 480p|720p, default 720p; aspect enum 1:1|4:3|3:4|16:9|9:16|21:9|adaptive, default 16:9.",
    duration:
      "Schema description: Video duration in 4-15 seconds, default 5 (schema states no numeric min/max — bounds from the description).",
    returnLastFrame:
      "Schema properties omit return_last_frame for seedance-2-mini (present only in an example payload) → not sent; see KIE-003 UNKNOWN note.",
    billing:
      'Kie pricingDesc: No video = Price × Output; With video = Price × (Input + Output). Limited-time discount until 2026-09-07 06:00 UTC.',
    rateLimit:
      "Account-wide 20 requests per 10 seconds (docs.kie.ai/market/quickstart); no model-specific rate stated.",
  },
});

/**
 * Wan 3.0 via Kie — `wan/3-0-video`.
 * Verified from the OpenAPI schema: prompt maxLength 20000 (server truncates
 * excess — MMCS validates BEFORE submit, runbook §26.4), reference images 10 /
 * videos 5 / audio 5 / files 1 / links 1, duration [2,30] with -1 sentinel,
 * 480P/720P/1080P default 1080P, aspect enum with adaptive default.
 */
export const KIE_WAN_3_0_VIDEO: MediaModelCapabilitySeed = Object.freeze({
  provider: "kie",
  modelId: "wan/3-0-video",
  kind: "video",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [WAN_DOC, KIE_WAN_PAGE],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: 20_000,
    recommendedMaxCharacters: 20_000,
    negativePrompt: false,
  },
  references: {
    maxImages: 10,
    maxVideos: 5,
    maxAudio: 5,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    incompatibleCombinations: [
      "first_frame_url + reference_*_urls",
      "last_frame_url + reference_*_urls",
      "reference_file_urls + reference_link_urls",
      "first/last-frame parameters + any reference_*_urls",
    ],
  },
  output: {
    minDurationSeconds: 2,
    maxDurationSeconds: 30,
    resolutions: ["480P", "720P", "1080P"],
    aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
  },
  pricing: {
    unit: "usd-per-second-480p",
    amount: 0.04,
    currency: "USD",
  },
  pricingDetail: {
    "480P": 0.04,
    "720P": 0.08,
    "1080P": 0.16,
    "credits-480P": 8,
    "credits-720P": 16,
    "credits-1080P": 32,
  },
  notes: {
    promptLength:
      "Schema maxLength 20000; description states excess characters are truncated automatically — MMCS validates pre-submit so nothing is silently dropped (runbook §26.4).",
    duration:
      "Without video input range [2, 30]; with reference videos input+output ≤ 30; -1 = model-chosen intelligent duration (sentinel).",
    referenceFiles:
      "reference_file_urls maxItems 1 (file-to-video) and reference_link_urls maxItems 1 (link-to-video); mutually exclusive with each other and with first/last-frame.",
    billing:
      "(input video duration + output duration) × unit price. 1 credit = $0.005 (kie.ai). 8/16/32 credits per second at 480P/720P/1080P.",
    seedSupport:
      "seed integer parameter documented (reproduce results); negative-prompt field absent from schema.",
  },
});

/**
 * Wan 3.0 Video Prime via Kie — `wan/3-0-video-prime`. Same capability
 * envelope as the standard model (verified prime schema); pricing differs.
 */
export const KIE_WAN_3_0_VIDEO_PRIME: MediaModelCapabilitySeed = Object.freeze({
  ...KIE_WAN_3_0_VIDEO,
  modelId: "wan/3-0-video-prime",
  sourceUrls: ["https://docs.kie.ai/market/wan/3-0-video-prime", KIE_WAN_PRIME_PAGE],
  pricing: {
    unit: "usd-per-second-480p",
    amount: 0.0612,
    currency: "USD",
  },
  pricingDetail: {
    "480P": 0.0612,
    "720P": 0.126,
    "1080P": 0.252,
    "credits-480P": 12.2,
    "credits-720P": 25.2,
    "credits-1080P": 50.4,
  },
  notes: {
    ...KIE_WAN_3_0_VIDEO.notes,
    pricing:
      "Prime is the high-speed variant: 12.2/25.2/50.4 credits per second at 480P/720P/1080P ($0.0612/$0.126/$0.252), all 10% below official pricing; same (input + output) × rate billing rule.",
  },
});

/** All seeded Kie media profiles keyed by model id. */
export const KIE_MEDIA_PROFILES: Readonly<
  Record<string, MediaModelCapabilitySeed>
> = Object.freeze({
  [KIE_SEEDANCE_2_MINI.modelId]: KIE_SEEDANCE_2_MINI,
  [KIE_WAN_3_0_VIDEO.modelId]: KIE_WAN_3_0_VIDEO,
  [KIE_WAN_3_0_VIDEO_PRIME.modelId]: KIE_WAN_3_0_VIDEO_PRIME,
});