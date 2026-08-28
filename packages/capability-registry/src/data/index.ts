/**
 * Capability data barrel — CAP-002.
 * Aggregates every seeded profile with provenance (lastVerifiedAt /
 * sourceUrls / confidence) into flat lookup maps for the registry, router
 * (spec §6), and pre-request validators (runbook §16).
 */

import { AGNES_MEDIA_PROFILES } from "./agnes.js";
import { KIE_MEDIA_PROFILES } from "./kie.js";
import { FISH_VOICE_PROFILES } from "./fish.js";
import { REASONING_PROFILES } from "./reasoning.js";

import type {
  CapabilitySeed,
  MediaModelCapabilitySeed,
  ReasoningModelCapabilitySeed,
  VoiceModelCapabilitySeed,
} from "./types.js";

export * from "./types.js";
export {
  AGNES_MEDIA_PROFILES,
  AGNES_VIDEO_2_5,
  AGNES_VIDEO_2_5_FLASH,
  AGNES_IMAGE_2_1_FLASH,
} from "./agnes.js";
export {
  KIE_MEDIA_PROFILES,
  KIE_SEEDANCE_2_MINI,
  KIE_WAN_3_0_VIDEO,
  KIE_WAN_3_0_VIDEO_PRIME,
} from "./kie.js";
export {
  FISH_VOICE_PROFILES,
  FISH_S1,
  FISH_S2_PRO,
  FISH_S2_1_PRO,
  FISH_S2_1_PRO_FREE,
} from "./fish.js";
export {
  REASONING_PROFILES,
  GLM_5_3_FLASH,
  DEEPSEEK_V4_FLASH_VISION_EXP,
  QWEN_3_8_FLASH,
  GEMINI_3_7_FLASH,
} from "./reasoning.js";

/** Every seeded media (image/video) profile keyed by model id. */
export const MEDIA_PROFILES: Readonly<Record<string, MediaModelCapabilitySeed>> =
  Object.freeze({ ...AGNES_MEDIA_PROFILES, ...KIE_MEDIA_PROFILES });

/** Every seeded voice profile keyed by model id. */
export const VOICE_PROFILES: Readonly<Record<string, VoiceModelCapabilitySeed>> =
  FISH_VOICE_PROFILES;

/** Every seeded reasoning/vision profile keyed by model id. */
export const REASONING_MODEL_PROFILES: Readonly<
  Record<string, ReasoningModelCapabilitySeed>
> = REASONING_PROFILES;

/** Every seeded capability record (all kinds), keyed by model id. */
export const ALL_PROFILES: Readonly<Record<string, CapabilitySeed>> =
  Object.freeze({
    ...MEDIA_PROFILES,
    ...VOICE_PROFILES,
    ...REASONING_MODEL_PROFILES,
  });

/** Look up a seeded profile by exact model id; undefined when unseeded. */
export function getProfile(modelId: string): CapabilitySeed | undefined {
  return ALL_PROFILES[modelId];
}

/** The verification date stamped on every seed in this package. */
export const DATA_VERIFIED_ON = "2026-08-28" as const;