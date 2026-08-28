import { describe, expect, it } from "vitest";

import {
  KIE_SEEDANCE_2_MINI,
  KIE_WAN_3_0_VIDEO,
  KIE_WAN_3_0_VIDEO_PRIME,
} from "../../../../capability-registry/src/data/kie.js";
import {
  KieCostError,
  estimateKieVideoCost,
  kieSpendDecision,
  toSpendEstimate,
} from "./cost.js";
import type { KieCostRequest } from "./cost.js";

/** Seedance 480p no-video rate, straight from the registry seed (fixture). */
const SEEDANCE_480_NO_VIDEO = KIE_SEEDANCE_2_MINI.pricingDetail?.["480p-no-video-input"];
const SEEDANCE_720_WITH_VIDEO = KIE_SEEDANCE_2_MINI.pricingDetail?.["720p-with-video-input"];
const WAN_480 = KIE_WAN_3_0_VIDEO.pricingDetail?.["480P"];
const WAN_1080 = KIE_WAN_3_0_VIDEO.pricingDetail?.["1080P"];
const WAN_PRIME_720 = KIE_WAN_3_0_VIDEO_PRIME.pricingDetail?.["720P"];

/** The fixture pricing must be present — these tests pin the registry rows. */
if (
  SEEDANCE_480_NO_VIDEO === undefined ||
  SEEDANCE_720_WITH_VIDEO === undefined ||
  WAN_480 === undefined ||
  WAN_1080 === undefined ||
  WAN_PRIME_720 === undefined
) {
  throw new Error("fixture pricing missing from capability-registry Kie seeds");
}

describe("estimateKieVideoCost — known registry pricing (fixture)", () => {
  it("prices Seedance 480p no-video as output seconds × rate", () => {
    const estimate = estimateKieVideoCost({
      modelId: "bytedance/seedance-2-mini",
      resolution: "480p",
      outputSeconds: 5,
    });
    expect(estimate.basis).toBe("priced_per_second");
    expect(estimate.pricePerSecond).toBe(SEEDANCE_480_NO_VIDEO);
    expect(estimate.billedSeconds).toBe(5);
    expect(estimate.estimatedCost).toBeCloseTo(Math.round(5 * SEEDANCE_480_NO_VIDEO * 100) / 100, 10);
    expect(estimate.confidence).toBe("VERIFIED");
    expect(estimate.sourceUrls.length).toBeGreaterThan(0);
  });

  it("prices Seedance 720p with reference video as (input + output) × with-video rate", () => {
    const estimate = estimateKieVideoCost({
      modelId: "bytedance/seedance-2-mini",
      resolution: "720p",
      outputSeconds: 6,
      inputVideoSeconds: 4,
    });
    expect(estimate.pricePerSecond).toBe(SEEDANCE_720_WITH_VIDEO);
    expect(estimate.billedSeconds).toBe(10);
    expect(estimate.estimatedCost).toBeCloseTo(10 * SEEDANCE_720_WITH_VIDEO, 10);
  });

  it("prices Wan 3.0 by resolution with the (input + output) billing rule", () => {
    const estimate = estimateKieVideoCost({
      modelId: "wan/3-0-video",
      resolution: "480P",
      outputSeconds: 10,
      inputVideoSeconds: 3,
    });
    expect(estimate.pricePerSecond).toBe(WAN_480);
    expect(estimate.billedSeconds).toBe(13);
    expect(estimate.estimatedCost).toBeCloseTo(13 * WAN_480, 10);
  });

  it("resolves resolution case-insensitively (wan 1080P vs '1080p')", () => {
    const estimate = estimateKieVideoCost({
      modelId: "wan/3-0-video",
      resolution: "1080p",
      outputSeconds: 8,
    });
    expect(estimate.pricePerSecond).toBe(WAN_1080);
    expect(estimate.estimatedCost).toBeCloseTo(8 * WAN_1080, 10);
  });

  it("prices Wan 3.0 Prime from its own (higher) rate table", () => {
    const estimate = estimateKieVideoCost({
      modelId: "wan/3-0-video-prime",
      resolution: "720P",
      outputSeconds: 10,
    });
    expect(estimate.pricePerSecond).toBe(WAN_PRIME_720);
    expect(estimate.estimatedCost).toBeCloseTo(10 * WAN_PRIME_720, 10);
  });

  it("rounds money to cents", () => {
    // 5s × 0.019 = 0.095 → 0.1 exactly; a case with >2dp noise:
    const estimate = estimateKieVideoCost({
      modelId: "bytedance/seedance-2-mini",
      resolution: "480p",
      outputSeconds: 7,
    });
    expect(estimate.estimatedCost).toBe(Math.round(estimate.estimatedCost! * 100) / 100);
  });
});

describe("estimateKieVideoCost — unknown pricing never guessed", () => {
  it("returns null cost for an unseeded model", () => {
    const estimate = estimateKieVideoCost({
      modelId: "future-model/unknown",
      resolution: "480p",
      outputSeconds: 5,
    });
    expect(estimate.basis).toBe("unknown_model");
    expect(estimate.pricePerSecond).toBeNull();
    expect(estimate.estimatedCost).toBeNull();
    expect(estimate.confidence).toBe("UNKNOWN");
  });

  it("returns null cost when the resolution has no pricing row", () => {
    const estimate = estimateKieVideoCost({
      modelId: "wan/3-0-video",
      resolution: "2160P",
      outputSeconds: 5,
    });
    expect(estimate.basis).toBe("unknown_resolution");
    expect(estimate.estimatedCost).toBeNull();
  });

  it("returns null cost when a profile lacks pricingDetail", () => {
    const stripped = {
      [KIE_WAN_3_0_VIDEO.modelId]: { ...KIE_WAN_3_0_VIDEO, pricingDetail: undefined },
    };
    const estimate = estimateKieVideoCost(
      { modelId: KIE_WAN_3_0_VIDEO.modelId, resolution: "480P", outputSeconds: 5 },
      stripped,
    );
    expect(estimate.basis).toBe("unknown_resolution");
    expect(estimate.estimatedCost).toBeNull();
  });

  it("treats a negative or non-finite pricing row as unknown, never a priced estimate", () => {
    const poisoned = {
      [KIE_WAN_3_0_VIDEO.modelId]: {
        ...KIE_WAN_3_0_VIDEO,
        pricingDetail: { ...KIE_WAN_3_0_VIDEO.pricingDetail, "480P": -0.04 },
      },
    };
    const negative = estimateKieVideoCost(
      { modelId: KIE_WAN_3_0_VIDEO.modelId, resolution: "480P", outputSeconds: 5 },
      poisoned,
    );
    expect(negative.basis).toBe("unknown_resolution");
    expect(negative.estimatedCost).toBeNull();

    const poisonedNaN = {
      [KIE_WAN_3_0_VIDEO.modelId]: {
        ...KIE_WAN_3_0_VIDEO,
        pricingDetail: { ...KIE_WAN_3_0_VIDEO.pricingDetail, "480P": Number.NaN },
      },
    };
    const nan = estimateKieVideoCost(
      { modelId: KIE_WAN_3_0_VIDEO.modelId, resolution: "480P", outputSeconds: 5 },
      poisonedNaN,
    );
    expect(nan.basis).toBe("unknown_resolution");
    expect(nan.estimatedCost).toBeNull();
  });

  it("rejects invalid requests before estimating", () => {
    expect(() => estimateKieVideoCost({ modelId: "  ", resolution: "480p", outputSeconds: 5 })).toThrow(KieCostError);
    expect(() => estimateKieVideoCost({ modelId: "wan/3-0-video", resolution: "", outputSeconds: 5 })).toThrow(KieCostError);
    expect(() => estimateKieVideoCost({ modelId: "wan/3-0-video", resolution: "480P", outputSeconds: 0 })).toThrow(KieCostError);
    expect(() =>
      estimateKieVideoCost({ modelId: "wan/3-0-video", resolution: "480P", outputSeconds: 5, inputVideoSeconds: -1 }),
    ).toThrow(KieCostError);
    expect(() =>
      estimateKieVideoCost({ modelId: "wan/3-0-video", resolution: "480P", outputSeconds: Number.NaN }),
    ).toThrow(KieCostError);
    // Non-string ids/resolutions must throw KieCostError, not a raw TypeError from .trim().
    expect(() =>
      estimateKieVideoCost({ modelId: 42 as unknown as string, resolution: "480p", outputSeconds: 5 }),
    ).toThrow(KieCostError);
    expect(() =>
      estimateKieVideoCost({ modelId: "wan/3-0-video", resolution: null as unknown as string, outputSeconds: 5 }),
    ).toThrow(KieCostError);
  });
});

describe("toSpendEstimate — CORE-009 reservation feed", () => {
  it("emits a registry SpendEstimate priced per billed second", () => {
    const estimate = toSpendEstimate({
      modelId: "wan/3-0-video",
      resolution: "480P",
      outputSeconds: 8,
      inputVideoSeconds: 2,
    });
    expect(estimate.provider).toBe("kie");
    expect(estimate.modelId).toBe("wan/3-0-video");
    expect(estimate.billableUnits).toBe(10);
    expect(estimate.quotaAbsorbedUnits).toBe(0);
    expect(estimate.pricePerUnit).toBe(WAN_480);
    expect(estimate.estimatedCost).toBeCloseTo(10 * WAN_480, 10);
    expect(estimate.basis).toBe("priced_per_unit");
    expect(estimate.currency).toBe("USD");
  });

  it("carries unknown pricing through as estimatedCost null (gates, never auto-approves)", () => {
    const estimate = toSpendEstimate({
      modelId: "future-model/unknown",
      resolution: "480p",
      outputSeconds: 5,
    });
    expect(estimate.estimatedCost).toBeNull();
    expect(estimate.basis).toBe("unknown_pricing");
  });
});

describe("kieSpendDecision — cumulative $25 rule over queued Kie calls", () => {
  const wan480 = (outputSeconds: number): KieCostRequest => ({
    modelId: "wan/3-0-video",
    resolution: "480P",
    outputSeconds,
  });

  it("auto-allows a small batch well under the limit", () => {
    const decision = kieSpendDecision([wan480(5), wan480(5)]);
    expect(decision.allowed).toBe(true);
    expect(decision.requires).toBe("automatic");
    expect(decision.projectedSpend).toBeCloseTo(10 * (WAN_480 as number), 2);
  });

  it("requires approval when the cumulative projection reaches $25", () => {
    // 10 calls × 60s × $0.04/s = $24.00; 11th call pushes ≥ $25.
    const decision = kieSpendDecision(Array.from({ length: 11 }, () => wan480(60)));
    expect(decision.requires).toBe("approval");
    expect(decision.allowed).toBe(false);
    expect((decision.projectedSpend as number)).toBeGreaterThanOrEqual(25);
  });

  it("counts alreadySpent toward the cumulative projection", () => {
    const decision = kieSpendDecision([wan480(5)], { alreadySpent: 24.9 });
    expect(decision.requires).toBe("approval");
  });

  it("forces approval for any unknown-priced call in the queue", () => {
    const decision = kieSpendDecision([
      wan480(5),
      { modelId: "future-model/unknown", resolution: "480p", outputSeconds: 5 },
    ]);
    expect(decision.requires).toBe("approval");
    expect(decision.allowed).toBe(false);
    expect(decision.projectedSpend).toBeNull();
  });
});