/**
 * KIE-007 — Kie cost calculator (@mmcs/providers/kie/cost).
 *
 * Per-model cost estimate from REGISTRY pricing BEFORE submission (spec §4,
 * runbook §33). Prices are read from the capability-registry Kie seeds
 * (CAP-002, verified 2026-08-28) — nothing is hard-coded in this module:
 * the per-resolution price tables live in each seed's `pricingDetail` and the
 * billing rules in its `notes.billing`:
 *
 *   - Seedance 2.0 Mini: no video input → Price × Output; with video input →
 *     Price(with-video rate) × (Input + Output). Table keys
 *     "<res>-with-video-input" / "<res>-no-video-input".
 *   - Wan 3.0 / Prime: (Input video duration + Output duration) × per-
 *     resolution price. Table keys "<res>".
 *
 * UNKNOWN pricing (unseeded model, missing resolution row, null amount) is
 * never guessed into a number: estimatedCost stays null and every consumer
 * must treat the request as REQUIRING operator approval (runbook §33 — an
 * unknown estimate may gate, never auto-approve).
 *
 * Feeds the CORE-009 reservation: {@link toSpendEstimate} emits the
 * capability-registry `SpendEstimate` shape the cost-engine reservation
 * ledger consumes; {@link kieSpendDecision} applies the cumulative $25 rule
 * across queued calls.
 *
 * Cross-package import note: the registry is pulled in via the repo-relative
 * source path (vitest + tsconfig.base both resolve .js→.ts for relative
 * imports; the @mmcs/* vitest alias covers only the bare package specifier,
 * not subpaths). Integration should add the workspace dependency to
 * packages/providers/package.json when package-graph wiring happens.
 */

import { KIE_MEDIA_PROFILES } from "../../../../capability-registry/src/data/kie.js";
import type { MediaModelCapabilitySeed } from "../../../../capability-registry/src/data/types.js";
import { decideSpend, estimateSpend, roundCents } from "../../../../capability-registry/src/pricing/pricing.js";
import type { ModelPricingProfile, SpendEstimate } from "../../../../capability-registry/src/pricing/pricing.js";

/** Confidence tier carried through from the registry seed. */
export type KieCostConfidence = "VERIFIED" | "PROVISIONAL" | "UNKNOWN";

/** How the estimate was derived. */
export type KieCostBasis =
  | "priced_per_second"
  | "unknown_model"
  | "unknown_pricing"
  | "unknown_resolution";

/** Request for a pre-submission Kie video cost estimate. */
export interface KieCostRequest {
  /** Exact registry model id (e.g. "bytedance/seedance-2-mini"). */
  modelId: string;
  /** Requested output resolution as the caller will send it (case-insensitive lookup). */
  resolution: string;
  /** Requested output clip length in seconds (> 0). */
  outputSeconds: number;
  /** Total seconds of reference VIDEO input billed alongside output (default 0). */
  inputVideoSeconds?: number;
}

/** Result of a pre-submission Kie cost estimate. */
export interface KieCostEstimate {
  provider: "kie";
  modelId: string;
  kind: "video";
  resolution: string;
  outputSeconds: number;
  inputVideoSeconds: number;
  /** Seconds billed under the Kie rule: input video seconds + output seconds. */
  billedSeconds: number;
  /** Price per billed second; null = unknown, never guessed. */
  pricePerSecond: number | null;
  /** Estimated cost in `currency`; null = unknown pricing/resolution. */
  estimatedCost: number | null;
  currency: string;
  basis: KieCostBasis;
  /** Registry provenance, preserved for the cost ledger. */
  sourceUrls: readonly string[];
  confidence: KieCostConfidence;
}

/** Error carrying the invalid cost-request field. */
export class KieCostError extends Error {
  readonly field: string;
  constructor(field: string, detail?: string) {
    super(`invalid kie cost ${field}${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "KieCostError";
    this.field = field;
  }
}

/** Registry seeds this calculator consults (injectable for tests). */
export type KieProfileMap = Readonly<Record<string, MediaModelCapabilitySeed>>;

/** Validate one non-negative finite second count. */
function requireSeconds(value: number, field: string, positive: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KieCostError(field, "must be a finite number");
  }
  if (positive ? value <= 0 : value < 0) {
    throw new KieCostError(field, positive ? "must be greater than zero" : "must not be negative");
  }
}

/**
 * Resolve the per-second price for a model/resolution/input-mode triple from
 * the seed's `pricingDetail` table. Returns null (UNKNOWN) when the table has
 * no matching row — never a guessed price.
 */
function lookupPricePerSecond(
  seed: MediaModelCapabilitySeed,
  resolution: string,
  withVideoInput: boolean,
): number | null {
  const detail = seed.pricingDetail;
  if (!detail) return null;
  const keys = Object.keys(detail);
  const wanted = resolution.trim().toLowerCase();
  let key: string | undefined;
  if (keys.some((candidate) => candidate.toLowerCase().endsWith("-with-video-input"))) {
    // Seedance-style table: rate depends on whether reference video is billed in.
    const suffix = withVideoInput ? "with-video-input" : "no-video-input";
    key = keys.find((candidate) => candidate.toLowerCase() === `${wanted}-${suffix}`);
  } else {
    key = keys.find((candidate) => candidate.toLowerCase() === wanted);
  }
  if (key === undefined) return null;
  const rate = detail[key] ?? null;
  // A negative or non-finite rate can never price a call: treat as unknown so
  // the $25 gate blocks instead of auto-approving a phantom or negative cost.
  return rate !== null && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/**
 * Estimate the cost of one Kie video generation from registry pricing.
 * Pure — no network, no clock — so callers can run it at the estimate gate
 * and again right before reservation without drift.
 */
export function estimateKieVideoCost(
  request: KieCostRequest,
  profiles: KieProfileMap = KIE_MEDIA_PROFILES,
): KieCostEstimate {
  if (typeof request.modelId !== "string") {
    throw new KieCostError("modelId", "must be a string");
  }
  if (typeof request.resolution !== "string") {
    throw new KieCostError("resolution", "must be a string");
  }
  const modelId = request.modelId.trim();
  if (modelId.length === 0) throw new KieCostError("modelId", "must be a non-empty model id");
  const resolution = request.resolution.trim();
  if (resolution.length === 0) throw new KieCostError("resolution", "must be a non-empty resolution");
  requireSeconds(request.outputSeconds, "outputSeconds", true);
  const inputVideoSeconds = request.inputVideoSeconds ?? 0;
  requireSeconds(inputVideoSeconds, "inputVideoSeconds", false);

  const seed = profiles[modelId];
  const billedSeconds = inputVideoSeconds + request.outputSeconds;
  const base = {
    provider: "kie" as const,
    modelId,
    kind: "video" as const,
    resolution,
    outputSeconds: request.outputSeconds,
    inputVideoSeconds,
    billedSeconds,
    sourceUrls: seed?.sourceUrls ?? [],
    confidence: seed?.confidence ?? ("UNKNOWN" as const),
  };

  if (seed === undefined) {
    return { ...base, currency: "USD", pricePerSecond: null, estimatedCost: null, basis: "unknown_model" };
  }
  const currency = seed.pricing.currency;
  if (seed.pricing.amount === null || currency.length !== 3 || currency !== currency.toUpperCase()) {
    return { ...base, currency, pricePerSecond: null, estimatedCost: null, basis: "unknown_pricing" };
  }
  const pricePerSecond = lookupPricePerSecond(seed, resolution, inputVideoSeconds > 0);
  if (pricePerSecond === null) {
    return { ...base, currency, pricePerSecond: null, estimatedCost: null, basis: "unknown_resolution" };
  }
  return {
    ...base,
    currency,
    pricePerSecond,
    estimatedCost: roundCents(billedSeconds * pricePerSecond),
    basis: "priced_per_second",
  };
}

/**
 * Emit the capability-registry `SpendEstimate` the CORE-009 reservation
 * ledger consumes. The registry seed's per-resolution table is folded into a
 * single per_video_second price for the exact (resolution, input-mode) pair
 * requested, then handed to the registry's own estimateSpend so quota and
 * rounding rules stay in one place.
 */
export function toSpendEstimate(
  request: KieCostRequest,
  profiles: KieProfileMap = KIE_MEDIA_PROFILES,
): SpendEstimate {
  const estimate = estimateKieVideoCost(request, profiles);
  const profile: ModelPricingProfile = {
    provider: "kie",
    modelId: estimate.modelId,
    kind: "video",
    pricing: {
      unit: estimate.pricePerSecond === null ? null : "per_video_second",
      amount: estimate.pricePerSecond,
      currency: estimate.currency,
      quota: null,
      overage: null,
    },
    includedQuota: { units: null, resetPeriod: null, subscription: false },
  };
  return estimateSpend(profile, {
    provider: "kie",
    modelId: estimate.modelId,
    kind: "video",
    units: estimate.billedSeconds,
  });
}

/**
 * Apply the runbook §33 cumulative $25 rule across queued Kie calls.
 * Every request is estimated first; any unknown-priced request forces
 * "approval" (never auto-approve), and the projection is cumulative across
 * ALL queued calls so parallel workers cannot each slip under the limit.
 */
export function kieSpendDecision(
  requests: readonly KieCostRequest[],
  options: { alreadySpent?: number; autoLimitUsd?: number } = {},
  profiles: KieProfileMap = KIE_MEDIA_PROFILES,
) {
  return decideSpend(
    requests.map((request) => toSpendEstimate(request, profiles)),
    { currency: "USD", ...options },
  );
}