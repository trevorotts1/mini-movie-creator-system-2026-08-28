/**
 * FISH-010 — Fish Audio cost estimation (@mmcs/providers fish-audio/config).
 *
 * Pricing basis (CAP-002 seeds, verified against docs.fish.audio 2026-08-28):
 * Fish Audio bills TTS at USD per MILLION UTF-8 BYTES of input text — the
 * `usd-per-million-utf8-bytes` unit. The capability-registry `estimateSpend`
 * engine (CAP-006) prices in "units × amount"; this module converts Fish's
 * per-million pricing into that shape so the CORE-009 reservation ledger
 * consumes ONE `SpendEstimate` shape regardless of provider:
 *
 *   units = UTF-8 byte length of the text; pricePerUnit = $/byte = $/1M ÷ 1M.
 *
 * UNKNOWN pricing is never guessed: an unseeded model or a null registry
 * amount yields `estimatedCost: null` with basis "unknown_pricing", and
 * every consumer must treat that as REQUIRING operator approval (runbook
 * §33 — an unknown estimate may gate, never auto-approve). The free tier
 * (s2.1-pro-free, $0) is priced from the seed like any other model — zero is
 * a configured value, never an assumption.
 *
 * `toSpendEstimate` / `fishSpendDecision` mirror the KIE-007 pattern so the
 * cost-engine sees identical semantics across providers.
 */

import { decideSpend } from "../../../../capability-registry/src/pricing/pricing.js";
import type { SpendEstimate } from "../../../../capability-registry/src/pricing/pricing.js";
import type { VoiceModelCapabilitySeed } from "../../../../capability-registry/src/data/types.js";
import type { CapabilityConfidence } from "../../../../capability-registry/src/data/types.js";
import { resolveFishModelConfig, FishConfigError } from "./model-config.js";
import type {
  FishModelConfigInput,
  FishProfileMap,
  ResolvedFishModelConfig,
} from "./model-config.js";
import { FISH_VOICE_PROFILES } from "../../../../capability-registry/src/data/fish.js";

/** Fish billing unit as seeded in the registry (verified 2026-08-28). */
export const FISH_BILLING_UNIT = "usd-per-million-utf8-bytes";

/** Fish bills per million UTF-8 bytes; this divisor converts $/1M to $/byte. */
export const BYTES_PER_MILLION = 1_000_000;

/** How the estimate was derived. */
export type FishCostBasis =
  | "priced_per_byte"
  | "unknown_pricing"
  | "unknown_model";

/** Request for a pre-submission Fish TTS cost estimate. */
export interface FishCostRequest {
  /** UTF-8 byte length of the text to synthesize (the billed unit). */
  textBytes: number;
}

/** Result of a pre-submission Fish TTS cost estimate. */
export interface FishCostEstimate {
  provider: "fish";
  modelId: string;
  kind: "voice";
  /** UTF-8 bytes billed (Fish's unit). */
  textBytes: number;
  /** Effective price per million UTF-8 bytes (override applied when present). */
  pricePerMillionBytes: number | null;
  /** Effective price per single byte; null = unknown pricing, never guessed. */
  pricePerByte: number | null;
  /** Estimated cost in `currency`; null = unknown pricing/model. */
  estimatedCost: number | null;
  currency: string;
  basis: FishCostBasis;
  /** Where the effective price came from. */
  priceSource: "registry" | "config_override" | null;
  /** True when the seed records this model as a free/fair-use tier. */
  freeTier: boolean;
  /** Registry provenance, preserved for the cost ledger. */
  sourceUrls: readonly string[];
  confidence: CapabilityConfidence;
}

/** Error carrying the invalid cost-request field. */
export class FishCostError extends Error {
  readonly field: string;
  constructor(field: string, detail?: string) {
    super(`invalid fish cost ${field}${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "FishCostError";
    this.field = field;
  }
}

/** Count the UTF-8 bytes Fish will bill for `text`. Node/browser TextEncoder. */
export function countUtf8Bytes(text: string): number {
  if (typeof text !== "string") {
    throw new FishCostError("text", "must be a string");
  }
  return Buffer.byteLength(text, "utf8");
}

/** Resolve the seed's price, null when the seed does not state one (UNKNOWN). */
function seedPrice(seed: VoiceModelCapabilitySeed): number | null {
  const amount = seed.pricing.amount;
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

/**
 * Estimate the cost of one Fish TTS call from registry pricing + config
 * overrides. Pure — no network, no clock — so callers can run it at the
 * estimate gate and again right before reservation without drift.
 *
 * Precision note (FISH-010): the cost is NOT rounded to cents. Fish prices
 * per UTF-8 byte, so a single dialogue line costs a fraction of a cent
 * (45 bytes ≈ $0.000675 at $15/M). Rounding per call to cents would zero
 * those lines out and systematically under-report cumulative byte-priced
 * spend to the CORE-009 $25 gate; the raw per-byte product keeps the
 * projection truthful, and {@link decideSpend} still rounds only its own
 * cumulative OUTPUT (float noise contained there, not baked into lines).
 */
export function estimateFishTtsCost(
  request: FishCostRequest,
  modelConfig: FishModelConfigInput,
  profiles: FishProfileMap = FISH_VOICE_PROFILES,
): FishCostEstimate {
  const textBytes = request.textBytes;
  if (typeof textBytes !== "number" || !Number.isFinite(textBytes)) {
    throw new FishCostError("textBytes", "must be a finite number");
  }
  if (textBytes < 0) {
    throw new FishCostError("textBytes", "must not be negative");
  }
  let resolved: ResolvedFishModelConfig;
  try {
    resolved = resolveFishModelConfig(modelConfig, profiles);
  } catch (error) {
    if (error instanceof FishConfigError && error.field === "model") {
      // No seeded profile for this model: unknown cost basis, never a guess.
      const modelId = modelConfig?.model?.trim() ?? "";
      return {
        provider: "fish",
        modelId,
        kind: "voice",
        textBytes,
        pricePerMillionBytes: null,
        pricePerByte: null,
        estimatedCost: null,
        currency: "USD",
        basis: "unknown_model",
        priceSource: null,
        freeTier: false,
        sourceUrls: [],
        confidence: "UNKNOWN",
      };
    }
    throw error;
  }

  const price = resolved.pricePerMillionBytes;
  const pricePerByte = price / BYTES_PER_MILLION;
  return {
    provider: "fish",
    modelId: resolved.model,
    kind: "voice",
    textBytes,
    pricePerMillionBytes: price,
    pricePerByte,
    estimatedCost: textBytes * pricePerByte,
    currency: resolved.seed.pricing.currency,
    basis: "priced_per_byte",
    priceSource: resolved.priceSource,
    freeTier: resolved.freeTier,
    sourceUrls: resolved.sourceUrls,
    confidence: resolved.confidence,
  };
}

/**
 * Emit the capability-registry `SpendEstimate` the CORE-009 reservation
 * ledger consumes. Fish's per-million-UTF-8-byte price is folded into a
 * single per_byte price, then handed to the registry's own estimateSpend so
 * quota and rounding rules stay in one place. Included quota is deliberately
 * null: the s2.1-pro-free tier is priced at $0 by the seed (a configured
 * value), not modeled as a depleting allowance that could silently run out
 * and start billing — free stays free-or-explicit, never half-modeled.
 */
export function toSpendEstimate(
  request: FishCostRequest,
  modelConfig: FishModelConfigInput,
  profiles: FishProfileMap = FISH_VOICE_PROFILES,
): SpendEstimate {
  const estimate = estimateFishTtsCost(request, modelConfig, profiles);
  const pricePerMillion = estimate.pricePerMillionBytes;
  const priced = estimate.basis === "priced_per_byte" && pricePerMillion !== null;
  // Built directly rather than via estimateSpend: the registry engine rounds
  // each line to cents, which zeroes byte-priced dialogue lines (45 bytes ≈
  // $0.000675 → $0.00) and under-reports the cumulative projection the CORE-009
  // $25 gate reads. Same shape, unrounded per-line cost; decideSpend rounds
  // only its own cumulative output.
  return {
    provider: "fish",
    modelId: estimate.modelId,
    billableUnits: estimate.textBytes,
    quotaAbsorbedUnits: 0,
    pricePerUnit: priced ? estimate.pricePerByte! : null,
    estimatedCost: estimate.estimatedCost,
    currency: estimate.currency,
    basis: priced ? "priced_per_unit" : "unknown_pricing",
  };
}

/**
 * Apply the runbook §33 cumulative $25 rule across queued Fish TTS calls.
 * Every request is estimated first; any unknown-priced request forces
 * "approval" (never auto-approve), and the projection is cumulative across
 * ALL queued calls so parallel workers cannot each slip under the limit.
 * `autoLimitUsd` comes from the resolved Fish model config (engine
 * AUTO_SPEND_LIMIT_USD, default 25).
 */
export function fishSpendDecision(
  requests: readonly FishCostRequest[],
  modelConfig: FishModelConfigInput,
  options: { alreadySpent?: number } = {},
  profiles: FishProfileMap = FISH_VOICE_PROFILES,
) {
  // Resolved WITHOUT the auto-limit validation gate: an unknown model here is
  // a legitimate estimate outcome (estimatedCost null → forced approval), not
  // a config error — throwing would break the gate that must gate. When the
  // model IS resolvable, its configured autoLimitUsd drives the decision.
  const resolved = (() => {
    try {
      return resolveFishModelConfig(modelConfig, profiles);
    } catch {
      return null;
    }
  })();
  return decideSpend(
    requests.map((request) => toSpendEstimate(request, modelConfig, profiles)),
    {
      alreadySpent: options.alreadySpent,
      autoLimitUsd: resolved?.autoLimitUsd,
      currency: "USD",
    },
  );
}

/**
 * Convenience: count bytes then estimate in one call, straight from the
 * dialogue text a caller is about to synthesize.
 */
export function estimateFishTtsCostForText(
  text: string,
  modelConfig: FishModelConfigInput,
  profiles: FishProfileMap = FISH_VOICE_PROFILES,
): FishCostEstimate {
  return estimateFishTtsCost({ textBytes: countUtf8Bytes(text) }, modelConfig, profiles);
}
