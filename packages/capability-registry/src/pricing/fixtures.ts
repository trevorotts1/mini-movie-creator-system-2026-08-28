import type {
  IncludedQuota,
  ModelPricingProfile,
  PricingProfile,
  PricingUnit,
} from "./pricing.js";
import { parseIncludedQuota } from "./pricing.js";

/**
 * Fixture pricing profiles for spend-estimation tests and budget-planner
 * consumers. Values mirror the runbook's provider baselines (Agnes/Kie video
 * tiers, image, voice) — PROVISIONAL-style fixture data, never shipped as
 * verified registry rows.
 */

/** Build one pricing fixture profile with sensible defaults. */
export function makeProfile(
  overrides: Partial<ModelPricingProfile> & {
    provider: string;
    modelId: string;
    kind: ModelPricingProfile["kind"];
  },
): ModelPricingProfile {
  const pricing: PricingProfile = {
    unit: null,
    amount: null,
    currency: "USD",
    quota: null,
    overage: null,
    ...overrides.pricing,
  };
  const includedQuota: IncludedQuota =
    overrides.includedQuota ?? parseIncludedQuota(pricing);
  return {
    provider: overrides.provider,
    modelId: overrides.modelId,
    kind: overrides.kind,
    pricing,
    includedQuota,
  };
}

/** No known pricing at all — the UNKNOWN baseline (never guessed into a number). */
export function unknownPricingFixture(
  provider: string,
  modelId: string,
  kind: ModelPricingProfile["kind"],
): ModelPricingProfile {
  return makeProfile({ provider, modelId, kind });
}

/** Named fixture set — typed keys so consumers get non-optional profiles. */
export interface FixtureProfiles {
  agnesFlash: ModelPricingProfile;
  agnesRegular: ModelPricingProfile;
  seedance: ModelPricingProfile;
  wan: ModelPricingProfile;
  image: ModelPricingProfile;
  voice: ModelPricingProfile;
}

/** The four runbook §26 video providers + image/voice, as fixture profiles. */
export function fixtureProfiles(): FixtureProfiles {
  const agnesFlash = makeProfile({
    provider: "agnes",
    modelId: "agnes-video-2.5-flash",
    kind: "video",
    pricing: {
      unit: "per_video_second",
      amount: 0.02,
      currency: "USD",
      quota: null,
      overage: null,
    },
  });
  const agnesRegular = makeProfile({
    provider: "agnes",
    modelId: "agnes-video-2.5",
    kind: "video",
    pricing: {
      unit: "per_video_second",
      amount: 0.05,
      currency: "USD",
      quota: "200 free video seconds monthly",
      overage: "billed per video second beyond monthly quota",
    },
  });
  const seedance = makeProfile({
    provider: "kie",
    modelId: "seedance-2.0-mini",
    kind: "video",
    pricing: {
      unit: "per_video_second",
      amount: 0.04,
      currency: "USD",
      quota: null,
      overage: null,
    },
  });
  const wan = makeProfile({
    provider: "kie",
    modelId: "wan-3.0",
    kind: "video",
    pricing: {
      unit: "per_video_second",
      amount: 0.07,
      currency: "USD",
      quota: "50 free video seconds monthly",
      overage: "$0.07 per video second beyond quota",
    },
  });
  const image = makeProfile({
    provider: "agnes",
    modelId: "agnes-image",
    kind: "image",
    pricing: {
      unit: "per_image",
      amount: 0.01,
      currency: "USD",
      quota: "500 free images monthly",
      overage: "$0.01 per image beyond quota",
    },
  });
  const voice = makeProfile({
    provider: "fish",
    modelId: "fish-s2.1-pro",
    kind: "voice",
    pricing: {
      unit: "per_audio_second",
      amount: 0.0,
      currency: "USD",
      quota: "developer-access free route (subject to change)",
      overage: "unknown until provider route changes",
    },
  });
  return {
    agnesFlash,
    agnesRegular,
    seedance,
    wan,
    image,
    voice,
  };
}

/** Unit names exported for fixture consumers that key by unit. */
export const FIXTURE_UNITS: readonly PricingUnit[] = [
  "per_video_second",
  "per_image",
  "per_audio_second",
];