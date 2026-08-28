import { describe, expect, it } from "vitest";

import {
  FISH_CONFIG_TTS_MODELS,
  FishConfigError,
  resolveFishModelConfig,
} from "./model-config.js";
import {
  BYTES_PER_MILLION,
  countUtf8Bytes,
  estimateFishTtsCost,
  estimateFishTtsCostForText,
  fishSpendDecision,
  FishCostError,
  toSpendEstimate,
} from "./cost.js";
import { FISH_VOICE_PROFILES } from "../../../../capability-registry/src/data/fish.js";
import type { VoiceModelCapabilitySeed } from "../../../../capability-registry/src/data/types.js";

/** Registry default: s2.1-pro at $15.00 / M UTF-8 bytes (verified 2026-08-28). */
const S2_1_PRO = {
  model: "s2.1-pro",
} as const;

describe("FISH-010 model selection", () => {
  it("requires an explicit model — no default, not even the free tier", () => {
    // spec §16 / runbook §30: selection is config-driven. An empty config
    // must never resolve to s2.1-pro (server default) or s2.1-pro-free.
    expect(() => resolveFishModelConfig({ model: "" })).toThrow(FishConfigError);
    expect(() =>
      resolveFishModelConfig({ model: "   " }),
    ).toThrow(/model is required from config/);
    expect(() =>
      resolveFishModelConfig(undefined as unknown as { model: string }),
    ).toThrow(FishConfigError);
  });

  it("resolves a seeded model with registry pricing", () => {
    const resolved = resolveFishModelConfig(S2_1_PRO);
    expect(resolved.model).toBe("s2.1-pro");
    expect(resolved.seed.modelId).toBe("s2.1-pro");
    expect(resolved.pricePerMillionBytes).toBe(15.0);
    expect(resolved.priceSource).toBe("registry");
    expect(resolved.freeTier).toBe(false);
    expect(resolved.sourceUrls.length).toBeGreaterThan(0);
    expect(resolved.confidence).toBe("VERIFIED");
  });

  it("resolves the free tier ONLY when explicitly configured", () => {
    const resolved = resolveFishModelConfig({ model: "s2.1-pro-free" });
    expect(resolved.model).toBe("s2.1-pro-free");
    expect(resolved.pricePerMillionBytes).toBe(0);
    expect(resolved.freeTier).toBe(true);
  });

  it("rejects a model the registry has not seeded (no pricing provenance)", () => {
    expect(() => resolveFishModelConfig({ model: "s2.1-mini" })).toThrow(
      /no seeded Fish registry profile/,
    );
    expect(() => resolveFishModelConfig({ model: "s2.1-turbo" })).toThrow(
      /no seeded Fish registry profile/,
    );
  });

  it("rejects a model the client model-header enum does not accept", () => {
    const ghost = {
      ...FISH_VOICE_PROFILES["s2.1-pro"],
      modelId: "ghost-model",
    } as VoiceModelCapabilitySeed;
    const profiles = { "ghost-model": ghost };
    expect(() => resolveFishModelConfig({ model: "ghost-model" }, profiles)).toThrow(
      /model` header enum/,
    );
  });

  it("every seed key is accepted by the client header enum (fixture integrity)", () => {
    for (const modelId of Object.keys(FISH_VOICE_PROFILES)) {
      expect(FISH_CONFIG_TTS_MODELS).toContain(modelId);
    }
  });

  it("validates autoLimitUsd when supplied", () => {
    expect(() => resolveFishModelConfig({ ...S2_1_PRO, autoLimitUsd: 0 })).toThrow(
      /autoLimitUsd/,
    );
    expect(() => resolveFishModelConfig({ ...S2_1_PRO, autoLimitUsd: -1 })).toThrow(
      /autoLimitUsd/,
    );
    expect(resolveFishModelConfig({ ...S2_1_PRO, autoLimitUsd: 100 }).autoLimitUsd).toBe(100);
  });
});

describe("FISH-010 pricing config overrides", () => {
  it("applies a config price override over the registry amount", () => {
    // Fish reprices → operator edits config, not code (spec §16).
    const resolved = resolveFishModelConfig({
      model: "s2.1-pro",
      priceOverrides: { "s2.1-pro": 22.5 },
    });
    expect(resolved.pricePerMillionBytes).toBe(22.5);
    expect(resolved.priceSource).toBe("config_override");
  });

  it("override can even re-price the free tier when Fish starts charging", () => {
    const resolved = resolveFishModelConfig({
      model: "s2.1-pro-free",
      priceOverrides: { "s2.1-pro-free": 15.0 },
    });
    expect(resolved.pricePerMillionBytes).toBe(15.0);
    expect(resolved.priceSource).toBe("config_override");
  });

  it("rejects NaN/Infinity/negative override prices at the config boundary", () => {
    expect(() =>
      resolveFishModelConfig({
        model: "s2.1-pro",
        priceOverrides: { "s2.1-pro": Number.NaN },
      }),
    ).toThrow(/priceOverrides/);
    expect(() =>
      resolveFishModelConfig({
        model: "s2.1-pro",
        priceOverrides: { "s2.1-pro": Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/priceOverrides/);
    expect(() =>
      resolveFishModelConfig({
        model: "s2.1-pro",
        priceOverrides: { "s2.1-pro": -0.01 },
      }),
    ).toThrow(/must not be negative/);
  });

  it("overrides for other models do not leak into this model's price", () => {
    const resolved = resolveFishModelConfig({
      model: "s2.1-pro",
      priceOverrides: { "s2.1-pro-free": 15.0 },
    });
    expect(resolved.priceSource).toBe("registry");
    expect(resolved.pricePerMillionBytes).toBe(15.0);
  });
});

describe("FISH-010 UTF-8 byte accounting", () => {
  it("counts ASCII bytes", () => {
    expect(countUtf8Bytes("hello world")).toBe(11);
  });

  it("counts multi-byte characters (CJK 3 bytes, emoji 4 bytes, accents 2 bytes)", () => {
    expect(countUtf8Bytes("日")).toBe(3);
    expect(countUtf8Bytes("日本語セリフ")).toBe(18);
    expect(countUtf8Bytes("🎬")).toBe(4);
    expect(countUtf8Bytes("é")).toBe(2);
  });

  it("counts empty text as zero bytes", () => {
    expect(countUtf8Bytes("")).toBe(0);
  });

  it("rejects non-string input", () => {
    expect(() => countUtf8Bytes(undefined as unknown as string)).toThrow(FishCostError);
  });
});

describe("FISH-010 cost estimation", () => {
  it("prices 1M bytes of s2.1-pro at $15.00", () => {
    const estimate = estimateFishTtsCost({ textBytes: BYTES_PER_MILLION }, S2_1_PRO);
    expect(estimate.basis).toBe("priced_per_byte");
    expect(estimate.estimatedCost).toBe(15);
    expect(estimate.pricePerByte).toBeCloseTo(0.000015, 10);
    expect(estimate.currency).toBe("USD");
    expect(estimate.priceSource).toBe("registry");
  });

  it("scales linearly: 100k bytes of s2.1-pro ≈ $1.50", () => {
    const estimate = estimateFishTtsCost({ textBytes: 100_000 }, S2_1_PRO);
    expect(estimate.estimatedCost).toBe(1.5);
  });

  it("a typical dialogue line lands in the fraction-of-a-cent range", () => {
    const bytes = countUtf8Bytes("I never thought you'd come back to Millbrook.");
    const estimate = estimateFishTtsCost({ textBytes: bytes }, S2_1_PRO);
    expect(estimate.estimatedCost).toBeGreaterThan(0);
    expect(estimate.estimatedCost).toBeLessThan(0.01);
  });

  it("prices the explicitly-selected free tier at $0 without pretending it is unknown", () => {
    const estimate = estimateFishTtsCost({ textBytes: 50_000 }, { model: "s2.1-pro-free" });
    expect(estimate.estimatedCost).toBe(0);
    expect(estimate.basis).toBe("priced_per_byte");
    expect(estimate.freeTier).toBe(true);
  });

  it("applies the config override to the estimate", () => {
    const estimate = estimateFishTtsCost(
      { textBytes: BYTES_PER_MILLION },
      { model: "s2.1-pro", priceOverrides: { "s2.1-pro": 30 } },
    );
    expect(estimate.estimatedCost).toBe(30);
    expect(estimate.priceSource).toBe("config_override");
  });

  it("returns unknown_model (null cost) for an unseeded model — never a guess", () => {
    const estimate = estimateFishTtsCost(
      { textBytes: 10_000 },
      { model: "s2.1-mini" },
    );
    expect(estimate.estimatedCost).toBeNull();
    expect(estimate.basis).toBe("unknown_model");
    expect(estimate.pricePerByte).toBeNull();
    expect(estimate.confidence).toBe("UNKNOWN");
  });

  it("rejects invalid byte counts", () => {
    expect(() => estimateFishTtsCost({ textBytes: -1 }, S2_1_PRO)).toThrow(/textBytes/);
    expect(() =>
      estimateFishTtsCost({ textBytes: Number.NaN }, S2_1_PRO),
    ).toThrow(/textBytes/);
    expect(() =>
      estimateFishTtsCost({ textBytes: Number.POSITIVE_INFINITY }, S2_1_PRO),
    ).toThrow(/textBytes/);
  });

  it("estimates straight from text via the convenience helper", () => {
    const estimate = estimateFishTtsCostForText("日本語のセリフです。", {
      model: "s2.1-pro",
    });
    // 9 CJK chars × 3 bytes + 。(3 bytes) = 30 UTF-8 bytes (Node-verified).
    expect(estimate.textBytes).toBe(30);
    expect(estimate.estimatedCost).toBeGreaterThan(0);
  });

  it("keeps sub-cent precision — per-byte lines are never rounded to zero", () => {
    // 7 bytes at $15/M = $0.000105. Rounding per line to cents would zero it;
    // the raw product keeps cumulative byte-priced spend truthful for CORE-009.
    const estimate = estimateFishTtsCost({ textBytes: 7 }, S2_1_PRO);
    expect(estimate.estimatedCost).toBeCloseTo(0.000105, 12);
    expect(estimate.estimatedCost).toBeGreaterThan(0);
    expect(estimate.basis).toBe("priced_per_byte");
  });
});

describe("FISH-010 CORE-009 feed (SpendEstimate + $25 rule)", () => {
  it("emits the registry SpendEstimate shape with per-byte pricing", () => {
    const spend = toSpendEstimate({ textBytes: BYTES_PER_MILLION }, S2_1_PRO);
    expect(spend.provider).toBe("fish");
    expect(spend.modelId).toBe("s2.1-pro");
    expect(spend.billableUnits).toBe(BYTES_PER_MILLION);
    expect(spend.quotaAbsorbedUnits).toBe(0);
    expect(spend.estimatedCost).toBe(15);
    expect(spend.currency).toBe("USD");
    expect(spend.basis).toBe("priced_per_unit");
  });

  it("emits estimatedCost null for an unknown model (gates, never auto-approves)", () => {
    const spend = toSpendEstimate({ textBytes: 10_000 }, { model: "s2.1-mini" });
    expect(spend.estimatedCost).toBeNull();
    expect(spend.basis).toBe("unknown_pricing");
  });

  it("free tier estimates $0 and stays inside the auto limit", () => {
    const decision = fishSpendDecision([{ textBytes: BYTES_PER_MILLION }], {
      model: "s2.1-pro-free",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requires).toBe("automatic");
    expect(decision.projectedSpend).toBe(0);
  });

  it("s2.1-pro dialogue stays well under the $25 auto limit", () => {
    // A whole episode of dialogue ≈ 60k UTF-8 bytes ≈ $0.90.
    const decision = fishSpendDecision([{ textBytes: 60_000 }], S2_1_PRO);
    expect(decision.allowed).toBe(true);
    expect(decision.projectedSpend).toBeCloseTo(0.9, 2);
  });

  it("crossing the auto limit requires approval (cumulative across queued calls)", () => {
    // 2M bytes at $15/M = $30 > $25 → blocked.
    const decision = fishSpendDecision(
      [{ textBytes: BYTES_PER_MILLION }, { textBytes: BYTES_PER_MILLION }],
      S2_1_PRO,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requires).toBe("approval");
    expect(decision.projectedSpend).toBe(30);
  });

  it("honors alreadySpent against the cumulative limit", () => {
    const decision = fishSpendDecision(
      [{ textBytes: BYTES_PER_MILLION }],
      S2_1_PRO,
      { alreadySpent: 20 },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.projectedSpend).toBe(35);
  });

  it("honors a config autoLimitUsd (engine AUTO_SPEND_LIMIT_USD)", () => {
    const decision = fishSpendDecision(
      [{ textBytes: BYTES_PER_MILLION }],
      { ...S2_1_PRO, autoLimitUsd: 10 },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.projectedSpend).toBe(15);
  });

  it("an unknown model inside a queue forces approval, never auto-approves", () => {
    const decision = fishSpendDecision(
      [{ textBytes: 100 }, { textBytes: 100 }],
      { model: "s2.1-mini" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requires).toBe("approval");
    expect(decision.projectedSpend).toBeNull();
  });

  it("an override repricing the free tier pushes it through the normal gate", () => {
    const decision = fishSpendDecision(
      [{ textBytes: BYTES_PER_MILLION }, { textBytes: BYTES_PER_MILLION }],
      { model: "s2.1-pro-free", priceOverrides: { "s2.1-pro-free": 20 } },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requires).toBe("approval");
    expect(decision.projectedSpend).toBe(40);
  });
});
