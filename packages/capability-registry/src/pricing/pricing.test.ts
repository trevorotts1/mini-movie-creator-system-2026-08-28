import { describe, expect, it } from "vitest";

import {
  AUTO_SPEND_LIMIT_USD,
  PricingError,
  decideSpend,
  estimateSpend,
  fixtureProfiles,
  isEstimable,
  makeProfile,
  parseIncludedQuota,
  roundCents,
  unknownPricingFixture,
  validatePricingProfile,
} from "./index.js";

describe("roundCents", () => {
  it("removes float noise from money math", () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3);
    expect(roundCents(6 * 0.07)).toBe(0.42);
  });
});

describe("parseIncludedQuota", () => {
  it("returns empty allowance for null/blank quota text", () => {
    expect(parseIncludedQuota({ unit: null, amount: null, currency: "USD", quota: null, overage: null })).toEqual({
      units: null,
      resetPeriod: null,
      subscription: false,
    });
    expect(
      parseIncludedQuota({ unit: "per_image", amount: 0.01, currency: "USD", quota: "  ", overage: null }),
    ).toEqual({ units: null, resetPeriod: null, subscription: false });
  });

  it("extracts leading unit count and reset period", () => {
    expect(parseIncludedQuota({ unit: "per_image", amount: 0.01, currency: "USD", quota: "500 free images monthly", overage: null })).toEqual({
      units: 500,
      resetPeriod: "monthly",
      subscription: true,
    });
    expect(
      parseIncludedQuota({ unit: "per_video_second", amount: 0.02, currency: "USD", quota: "200 credits/mo", overage: null }),
    ).toMatchObject({ units: 200, resetPeriod: "monthly" });
    expect(
      parseIncludedQuota({ unit: "per_video_second", amount: 0.02, currency: "USD", quota: "10 free seconds daily", overage: null }),
    ).toMatchObject({ units: 10, resetPeriod: "daily" });
    expect(
      parseIncludedQuota({ unit: "per_request", amount: 0.001, currency: "USD", quota: "3 free calls weekly", overage: null }),
    ).toMatchObject({ units: 3, resetPeriod: "weekly" });
  });

  it("marks non-numeric free-text quota as subscription with unknown units", () => {
    expect(
      parseIncludedQuota({ unit: "per_audio_second", amount: 0, currency: "USD", quota: "developer-access free route", overage: null }),
    ).toEqual({ units: null, resetPeriod: null, subscription: true });
  });
});

describe("validatePricingProfile", () => {
  it("accepts a fully priced profile and an UNKNOWN profile", () => {
    const priced = makeProfile({
      provider: "agnes",
      modelId: "agnes-video-2.5-flash",
      kind: "video",
      pricing: { unit: "per_video_second", amount: 0.02, currency: "USD", quota: null, overage: null },
    });
    expect(() => validatePricingProfile(priced)).not.toThrow();
    expect(() => validatePricingProfile(unknownPricingFixture("kie", "wan-3.0", "video"))).not.toThrow();
  });

  it("allows partial unit/amount states — those are UNKNOWN, estimateSpend classifies them", () => {
    const unitNoAmount = makeProfile({
      provider: "x",
      modelId: "m",
      kind: "video",
      pricing: { unit: "per_video_second", amount: null, currency: "USD", quota: null, overage: null },
    });
    expect(() => validatePricingProfile(unitNoAmount)).not.toThrow();
    const amountNoUnit = makeProfile({
      provider: "x",
      modelId: "m",
      kind: "video",
      pricing: { unit: null, amount: 0.02, currency: "USD", quota: null, overage: null },
    });
    expect(() => validatePricingProfile(amountNoUnit)).not.toThrow();
  });

  it("rejects bad currency and negative amount", () => {
    const badCurrency = makeProfile({
      provider: "x",
      modelId: "m",
      kind: "video",
      pricing: { unit: "per_image", amount: 0.01, currency: "usd", quota: null, overage: null },
    });
    expect(() => validatePricingProfile(badCurrency)).toThrow(PricingError);
    const negative = makeProfile({
      provider: "x",
      modelId: "m",
      kind: "video",
      pricing: { unit: "per_image", amount: -1, currency: "USD", quota: null, overage: null },
    });
    expect(() => validatePricingProfile(negative)).toThrow(PricingError);
  });
});

describe("estimateSpend", () => {
  const fixtures = fixtureProfiles();

  it("prices a 12-second Flash shot at 12 × $0.02 = $0.24", () => {
    const est = estimateSpend(fixtures.agnesFlash, {
      provider: "agnes",
      modelId: "agnes-video-2.5-flash",
      kind: "video",
      units: 12,
    });
    expect(est).toMatchObject({
      billableUnits: 12,
      quotaAbsorbedUnits: 0,
      pricePerUnit: 0.02,
      estimatedCost: 0.24,
      currency: "USD",
      basis: "priced_per_unit",
    });
  });

  it("estimates a full episode's video spend across the four video fixtures", () => {
    // 45-second scene: 6+8+7+10+5+9 seconds (runbook §20 example scene).
    const shotSeconds = [6, 8, 7, 10, 5, 9];
    const total = shotSeconds.reduce(
      (sum, s) =>
        sum +
        (estimateSpend(fixtures.agnesFlash, {
          provider: "agnes",
          modelId: "agnes-video-2.5-flash",
          kind: "video",
          units: s,
        }).estimatedCost ?? 0),
      0,
    );
    expect(roundCents(total)).toBe(0.9);
  });

  it("covers billable units with included quota first (free allowance not paid spend)", () => {
    // Wan: 50 free seconds/mo. 45s scene → all covered, paid $0.
    const covered = estimateSpend(fixtures.wan, {
      provider: "kie",
      modelId: "wan-3.0",
      kind: "video",
      units: 45,
      quotaUsed: 0,
    });
    expect(covered).toMatchObject({ billableUnits: 0, quotaAbsorbedUnits: 45, estimatedCost: 0, basis: "quota_covered" });

    // Same period, 40s more: 5 free + 35 paid.
    const partial = estimateSpend(fixtures.wan, {
      provider: "kie",
      modelId: "wan-3.0",
      kind: "video",
      units: 40,
      quotaUsed: 45,
    });
    expect(partial).toMatchObject({ billableUnits: 35, quotaAbsorbedUnits: 5, estimatedCost: 2.45, basis: "partial_quota" });

    // Quota exhausted: 12s fully paid.
    const paid = estimateSpend(fixtures.wan, {
      provider: "kie",
      modelId: "wan-3.0",
      kind: "video",
      units: 12,
      quotaUsed: 50,
    });
    expect(paid).toMatchObject({ billableUnits: 12, quotaAbsorbedUnits: 0, estimatedCost: 0.84, basis: "priced_per_unit" });
  });

  it("returns estimatedCost null for UNKNOWN pricing — never a guessed number", () => {
    const unknown = unknownPricingFixture("agnes", "agnes-video-2.5-flash-undocumented-tier", "video");
    const est = estimateSpend(unknown, {
      provider: "agnes",
      modelId: "agnes-video-2.5-flash-undocumented-tier",
      kind: "video",
      units: 12,
    });
    expect(est.estimatedCost).toBeNull();
    expect(est.pricePerUnit).toBeNull();
    expect(est.basis).toBe("unknown_pricing");
    expect(isEstimable(est)).toBe(false);
  });

  it("returns unknown_unit basis when amount exists but unit is null", () => {
    const noUnit = makeProfile({
      provider: "x",
      modelId: "m",
      kind: "image",
      pricing: { unit: null, amount: 0.01, currency: "USD", quota: null, overage: null },
    });
    const est = estimateSpend(noUnit, { provider: "x", modelId: "m", kind: "image", units: 3 });
    expect(est.estimatedCost).toBeNull();
    expect(est.basis).toBe("unknown_unit");
  });

  it("handles a zero-cost developer route (Fish) as free only when actually $0/unit", () => {
    const est = estimateSpend(fixtures.voice, {
      provider: "fish",
      modelId: "fish-s2.1-pro",
      kind: "voice",
      units: 300,
    });
    expect(est.estimatedCost).toBe(0);
    expect(est.basis).toBe("priced_per_unit");
  });

  it("rejects non-finite and negative unit requests", () => {
    expect(() =>
      estimateSpend(fixtures.agnesFlash, {
        provider: "agnes",
        modelId: "agnes-video-2.5-flash",
        kind: "video",
        units: -1,
      }),
    ).toThrow(PricingError);
    expect(() =>
      estimateSpend(fixtures.agnesFlash, {
        provider: "agnes",
        modelId: "agnes-video-2.5-flash",
        kind: "video",
        units: Number.NaN,
      }),
    ).toThrow(PricingError);
  });
});

describe("decideSpend ($25 rule, runbook §33)", () => {
  const fixtures = fixtureProfiles();
  const flash12 = () =>
    estimateSpend(fixtures.agnesFlash, {
      provider: "agnes",
      modelId: "agnes-video-2.5-flash",
      kind: "video",
      units: 12,
    });

  it("auto-approves below the $25 cumulative limit", () => {
    const decision = decideSpend([flash12(), flash12()]);
    expect(decision.allowed).toBe(true);
    expect(decision.requires).toBe("automatic");
    expect(decision.projectedSpend).toBe(0.48);
  });

  it("requires approval at/above $25 cumulative — not per-call", () => {
    // Five workers × 100 twelve-second Flash calls = $120 cumulative.
    const perWorker = 100;
    const calls = Array.from({ length: 5 }, () => flash12());
    const one = decideSpend(Array.from({ length: perWorker }, flash12), { alreadySpent: 0 });
    expect(one.allowed).toBe(true); // $24 alone is fine
    expect(one.projectedSpend).toBeCloseTo(24, 5);
    void calls;
    const five = decideSpend(Array.from({ length: 5 * perWorker }, flash12));
    expect(five.allowed).toBe(false);
    expect(five.requires).toBe("approval");
  });

  it("requires approval when alreadySpent pushes the projection over the limit", () => {
    const decision = decideSpend([flash12()], { alreadySpent: 24.9 });
    expect(decision.allowed).toBe(false);
    expect(decision.requires).toBe("approval");
  });

  it("treats unknown pricing as approval-required, never automatic", () => {
    const unknown = estimateSpend(unknownPricingFixture("agnes", "undocumented", "video"), {
      provider: "agnes",
      modelId: "undocumented",
      kind: "video",
      units: 12,
    });
    const decision = decideSpend([unknown]);
    expect(decision.allowed).toBe(false);
    expect(decision.requires).toBe("approval");
    expect(decision.projectedSpend).toBeNull();
  });

  it("exposes the default auto limit as 25.00", () => {
    expect(AUTO_SPEND_LIMIT_USD).toBe(25.0);
  });
});

describe("fixtureProfiles", () => {
  it("covers the four runbook §26 video tiers plus image and voice", () => {
    const fixtures = fixtureProfiles();
    expect(Object.keys(fixtures).sort()).toEqual([
      "agnesFlash",
      "agnesRegular",
      "image",
      "seedance",
      "voice",
      "wan",
    ]);
    for (const profile of Object.values(fixtures)) {
      expect(() => validatePricingProfile(profile)).not.toThrow();
      expect(profile.includedQuota).toEqual(parseIncludedQuota(profile.pricing));
    }
  });

  it("prices the four video fixtures with distinct per-second costs", () => {
    const fixtures = fixtureProfiles();
    expect(fixtures.agnesFlash.pricing.amount).toBeLessThan(fixtures.agnesRegular.pricing.amount ?? 0);
    expect(fixtures.seedance.pricing.amount).toBeLessThan(fixtures.wan.pricing.amount ?? 0);
    expect(new Set([fixtures.agnesFlash, fixtures.agnesRegular, fixtures.seedance, fixtures.wan].map((f) => f.pricing.amount)).size).toBe(4);
  });
});