/**
 * Agnes provider family — seeded capability data (CAP-002).
 *
 * Every value below was read from the live official Agnes AI docs on
 * 2026-08-28 (all URLs fetched HTTP 200):
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash.md (pricing)
 *   - https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
 *   - https://wiki.agnes-ai.com/en/docs/pricing.md
 *
 * BINDING (runbook §26.1/§26.2 + §25 acceptance): the Agnes hard prompt
 * character ceiling is NOT documented anywhere in the official docs. It stays
 * UNKNOWN (null). Never copy another model's limit into it. A dedicated test
 * asserts the UNKNOWN survives.
 */

import type { MediaModelCapabilitySeed } from "./types.js";

const VERIFIED_ON = "2026-08-28";

const VIDEO_25_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-video-25";
const VIDEO_25F_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash";
const PRICING_DOC = "https://wiki.agnes-ai.com/en/docs/pricing";
const IMAGE_21_DOC = "https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash";

/**
 * Agnes Video 2.5 Flash — `agnes-video-2.5-flash`.
 * Verified limits from the Flash page: size fixed "720P" (other values HTTP
 * 400), `images` max 5, `videos` unsupported, seconds "4"–"12" string,
 * keyframe first/last supported, aspect ratios per the pixel table,
 * list price $0.025/s 720P (currently $0 promo).
 * Prompt character limit: NOT STATED anywhere → UNKNOWN.
 */
export const AGNES_VIDEO_2_5_FLASH: MediaModelCapabilitySeed = Object.freeze({
  provider: "agnes",
  modelId: "agnes-video-2.5-flash",
  kind: "video",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [VIDEO_25F_DOC, VIDEO_25_DOC, PRICING_DOC],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    negativePrompt: null,
  },
  references: {
    maxImages: 5,
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
    resolutions: ["720P"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  },
  pricing: {
    unit: "usd-per-output-second-720p",
    amount: 0.025,
    currency: "USD",
  },
  pricingDetail: {
    "list-720P": 0.025,
    "current-720P": 0,
    "excess-input-image": 0.005,
  },
  notes: {
    promptHardMax:
      "No prompt character limit stated on the Agnes Video 2.5 Flash or Video 2.5 doc pages (checked 2026-08-28). Preserved UNKNOWN — runbook §26.1 forbids inventing a ceiling.",
    maxVideos:
      "Flash rejects any non-empty videos array (HTTP 400 videos is not supported); no count limit applies, so maxVideos stays null with videosUnsupported.",
    maxAudio:
      "Reference audio allowed per Agnes Video 2.5 common rules; no max count stated on either page → UNKNOWN.",
    outputDurations:
      'seconds is a string "4"–"12", default "5" (both pages).',
    resolutions:
      'Flash size is fixed to "720P"; other values return HTTP 400 size must be 720P.',
    billing:
      "Total = output s × rate + input video s × rate + max(0, images − 5) × $0.005. Currently $0 during limited-time promotion.",
    retrieval:
      "GET /agnesapi?video_id=…&model_name=agnes-video-2.5-flash required for keyframe/reference modes.",
  },
});

/**
 * Agnes Video 2.5 regular — `agnes-video-2.5`.
 * Verified: 720P/960P/2K tiers, seconds "4"–"12", keyframe + multimodal
 * reference (images/audios/videos), aspect table for 720P tier, pricing
 * $0.025/$0.040/$0.055 per second. Image max count NOT stated (only the
 * free-allowance billing rule mentions 5) → UNKNOWN.
 */
export const AGNES_VIDEO_2_5: MediaModelCapabilitySeed = Object.freeze({
  provider: "agnes",
  modelId: "agnes-video-2.5",
  kind: "video",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [VIDEO_25_DOC, PRICING_DOC],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    negativePrompt: null,
  },
  references: {
    maxImages: null,
    maxVideos: null,
    maxAudio: null,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    incompatibleCombinations: [
      "mode=keyframe excludes images/audios/videos",
      "mode=reference excludes first_frame/last_frame",
    ],
  },
  output: {
    minDurationSeconds: 4,
    maxDurationSeconds: 12,
    resolutions: ["720P", "960P", "2K"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  },
  pricing: {
    unit: "usd-per-output-second-720p",
    amount: 0.025,
    currency: "USD",
  },
  pricingDetail: {
    "720P": 0.025,
    "960P": 0.04,
    "2K": 0.055,
    "free-image-allowance": 5,
    "excess-input-image": 0.005,
  },
  notes: {
    promptHardMax:
      "No prompt character limit stated on the Agnes Video 2.5 doc page (checked 2026-08-28). Preserved UNKNOWN — runbook §26.2.",
    maxImages:
      "Reference mode accepts images[] but no max count stated; only the billing rule notes the first 5 input images are free (that is a price allowance, not a documented hard cap) → UNKNOWN.",
    maxVideos:
      "Reference mode accepts videos[] objects (url/start_seconds/require_audio); no max count stated → UNKNOWN.",
    maxAudio:
      "Reference mode accepts audios[]; no max count stated → UNKNOWN.",
    outputDurations:
      'seconds is a string "4"–"12", default "5".',
    resolutions:
      'size accepts "720P", "960P", "2K" (WIDTHxHEIGHT and auto rejected with 400).',
    billing:
      "Total = output s × resolution rate + input video s × resolution rate + max(0, images − 5) × $0.005.",
  },
});

/**
 * Agnes Image 2.1 Flash — `agnes-image-2.1-flash` (preferred image path,
 * runbook §29). Verified: 1K/2K/3K/4K tiers, 8 aspect ratios, image[] array
 * for i2i/multi-image composition. Reference image max count NOT stated →
 * UNKNOWN (only the first-3-free billing rule is documented).
 */
export const AGNES_IMAGE_2_1_FLASH: MediaModelCapabilitySeed = Object.freeze({
  provider: "agnes",
  modelId: "agnes-image-2.1-flash",
  kind: "image",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [IMAGE_21_DOC, PRICING_DOC],
  confidence: "VERIFIED",
  prompt: {
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    negativePrompt: null,
  },
  references: {
    maxImages: null,
    maxVideos: null,
    maxAudio: null,
    firstFrame: false,
    lastFrame: false,
    firstLastFrame: false,
    multimodalReferences: true,
    incompatibleCombinations: [],
  },
  output: {
    minDurationSeconds: null,
    maxDurationSeconds: null,
    resolutions: ["1K", "2K", "3K", "4K"],
    aspectRatios: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
  },
  pricing: {
    unit: "usd-per-image-1k",
    amount: 10.0,
    currency: "USD",
  },
  pricingDetail: {
    "list-1K": 10,
    "current-all-tiers": 0,
    "free-image-allowance": 3,
    "excess-input-image": 0.003,
  },
  notes: {
    promptHardMax:
      "No prompt character limit stated on the Agnes Image 2.1 Flash page (checked 2026-08-28) → UNKNOWN.",
    maxImages:
      "image[] supports multiple for multi-image composition; no max stated, only first-3-free billing rule → UNKNOWN.",
    outputDurations:
      "Still-image model; durations not applicable → nulls.",
    pricingNote:
      "List price $10/1,000 images at every tier; all tiers + reference images currently free (promo).",
    seedSupport:
      "Seed parameter not documented for the image API → UNKNOWN (omitted, not asserted).",
  },
});

/** All seeded Agnes media profiles keyed by model id. */
export const AGNES_MEDIA_PROFILES: Readonly<
  Record<string, MediaModelCapabilitySeed>
> = Object.freeze({
  [AGNES_VIDEO_2_5_FLASH.modelId]: AGNES_VIDEO_2_5_FLASH,
  [AGNES_VIDEO_2_5.modelId]: AGNES_VIDEO_2_5,
  [AGNES_IMAGE_2_1_FLASH.modelId]: AGNES_IMAGE_2_1_FLASH,
});