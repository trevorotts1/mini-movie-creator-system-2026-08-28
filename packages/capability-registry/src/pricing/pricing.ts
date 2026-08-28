/**
 * Pricing/quota model for the MMCS Model Capability Registry (runbook §22
 * pricing block, §33 Cost/Quota Engine; spec subsystems 2 + 15). Every model
 * profile carries a `pricing` block — unit, current price, currency, included
 * quota, overage — and this module turns those fields into cost estimates and
 * quota accounting the budget systems consult before any paid call.
 *
 * UNKNOWN pricing (null unit/amount) must never become a guessed number: an
 * unknown-priced model estimates as `estimatedCost: null` and the caller treats
 * that as "cannot pre-approve automatically" (runbook §33: below $25 automatic,
 * at/above requires approval — an unknown estimate can only ever be treated as
 * requiring approval, never as free).
 */

/** How a model charges. `per_unit` multiplies amount × units; `included_quota` is subscription allowance. */
export type PricingUnit =
  | "per_video_second"
  | "per_image"
  | "per_character"
  | "per_token_1k"
  | "per_request"
  | "per_audio_second"
  | "per_megapixel"
  | "per_gb_month"
  | null;

/** Included/subscription allowance for a model, tracked separately from paid spend (runbook §33). */
export interface IncludedQuota {
  /** How much is included in the plan, expressed in the pricing unit (e.g. 100 = 100 free units). */
  units: number | null;
  /** Reset cadence of the included allowance (e.g. "monthly"). null = unknown. */
  resetPeriod: string | null;
  /** True when the quota is a paid subscription's included allowance. */
  subscription: boolean;
}

/** Pricing block shape — structurally compatible with the registry's `pricing` field. */
export interface PricingProfile {
  /** Billing unit name; null = unknown, never invented. */
  unit: PricingUnit;
  /** Current price per unit in `currency`; null = unknown. */
  amount: number | null;
  /** ISO-4217-ish currency code (3 letters). */
  currency: string;
  /** Human-readable included-quota note from the provider (e.g. "1000 credits/mo"). */
  quota: string | null;
  /** Human-readable overage note (e.g. "$0.05/credit beyond quota"). */
  overage: string | null;
}

/** A model's pricing plus its parsed included quota. */
export interface ModelPricingProfile {
  provider: string;
  modelId: string;
  kind: "reasoning" | "vision" | "image" | "video" | "voice" | "storage";
  pricing: PricingProfile;
  /** Parsed included allowance; null `units` = no known free tier (all spend is paid). */
  includedQuota: IncludedQuota;
}

/** Request for a spend estimate: how many units of what model. */
export interface SpendRequest {
  provider: string;
  modelId: string;
  kind: ModelPricingProfile["kind"];
  /** Units consumed this call (video seconds, images, characters, …). */
  units: number;
  /** Already-consumed included-quota units this billing period (default 0). */
  quotaUsed?: number;
}

/** Result of a spend estimate. */
export interface SpendEstimate {
  provider: string;
  modelId: string;
  /** Units billed at `pricePerUnit` after quota deduction. */
  billableUnits: number;
  /** Units absorbed by included quota this call (paid spend = 0 for these). */
  quotaAbsorbedUnits: number;
  /** Price per paid unit; null = unknown pricing, never guessed. */
  pricePerUnit: number | null;
  /** Estimated cost in `currency`; null = unknown pricing or unknown unit. */
  estimatedCost: number | null;
  currency: string;
  /** How the cost was derived. */
  basis:
    | "quota_covered"
    | "priced_per_unit"
    | "partial_quota"
    | "unknown_pricing"
    | "unknown_unit";
}

/** A spend decision under the runbook §33 $25 rule. */
export interface SpendDecision {
  allowed: boolean;
  /** "approval" when at/above the auto limit or the estimate is unknown. */
  requires: "automatic" | "approval";
  /** Cumulative projected paid spend AFTER this call (null when unestimable). */
  projectedSpend: number | null;
  currency: string;
  /** Human-readable reason, safe to show an operator. */
  reason: string;
}

/** Default auto-spend ceiling per runbook §33. */
export const AUTO_SPEND_LIMIT_USD = 25.0;

/** Parse `pricing.quota` free text into a structured included allowance. */
export function parseIncludedQuota(pricing: PricingProfile): IncludedQuota {
  const quota = pricing.quota?.trim() ?? "";
  if (quota === "") {
    return { units: null, resetPeriod: null, subscription: false };
  }
  // "1000 credits/mo", "100 free units monthly", "$25 of included usage" —
  // the only machine-usable part is a leading unit count.
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*/.exec(quota);
  const units = match === null ? null : Number(match[1]);
  const resetPeriod = /month|mo\b|monthly/i.test(quota)
    ? "monthly"
    : /day|daily/i.test(quota)
      ? "daily"
      : /week/i.test(quota)
        ? "weekly"
        : null;
  const subscription = units !== null || /\b(subscription|included|free)\b/i.test(quota);
  return { units, resetPeriod, subscription };
}

/** Validate a pricing profile; throws with the offending field named. */
export function validatePricingProfile(profile: ModelPricingProfile): void {
  const { provider, modelId, pricing } = profile;
  if (provider.length === 0) throw new PricingError("provider", profile);
  if (modelId.length === 0) throw new PricingError("modelId", profile);
  if (pricing.currency.length !== 3 || pricing.currency !== pricing.currency.toUpperCase()) {
    throw new PricingError("currency", profile);
  }
  // NaN/Infinity must be rejected: NaN < 0 is false, and an NaN amount would
  // otherwise flow into estimates as NaN cost that isEstimable() counts as
  // estimable — silently bypassing the $25 auto-spend gate (runbook §33).
  if (pricing.amount !== null && (!Number.isFinite(pricing.amount) || pricing.amount < 0)) {
    throw new PricingError("amount", profile);
  }
}

/** Error carrying the invalid pricing field. */
export class PricingError extends Error {
  readonly field: string;
  constructor(field: string, profile: ModelPricingProfile) {
    super(`invalid pricing ${field} for ${profile.provider}/${profile.modelId}`);
    this.name = "PricingError";
    this.field = field;
  }
}

/**
 * Estimate spend for one call against one profile. Included quota is consumed
 * first; only units beyond it are paid. Unknown pricing yields estimatedCost
 * null with basis "unknown_pricing" — never a guessed number.
 */
export function estimateSpend(
  profile: ModelPricingProfile,
  request: SpendRequest,
): SpendEstimate {
  validatePricingProfile(profile);
  if (!Number.isFinite(request.units) || request.units < 0) {
    throw new PricingError("units", profile);
  }
  if (
    request.quotaUsed !== undefined &&
    (!Number.isFinite(request.quotaUsed) || request.quotaUsed < 0)
  ) {
    // A negative quotaUsed would inflate remaining allowance and turn paid
    // units into phantom free ones; NaN would poison every downstream total.
    throw new PricingError("quotaUsed", profile);
  }
  const included = profile.includedQuota.units ?? 0;
  const quotaUsed = request.quotaUsed ?? 0;
  const quotaRemaining = Math.max(0, included - quotaUsed);
  const quotaAbsorbedUnits = Math.min(quotaRemaining, request.units);
  const billableUnits = request.units - quotaAbsorbedUnits;

  const base = {
    provider: profile.provider,
    modelId: profile.modelId,
    quotaAbsorbedUnits,
    billableUnits,
    currency: profile.pricing.currency,
  };

  if (profile.pricing.unit === null || profile.pricing.amount === null) {
    return {
      ...base,
      pricePerUnit: null,
      estimatedCost: null,
      basis: profile.pricing.amount === null ? "unknown_pricing" : "unknown_unit",
    };
  }
  if (billableUnits === 0) {
    return {
      ...base,
      pricePerUnit: profile.pricing.amount,
      estimatedCost: 0,
      basis: "quota_covered",
    };
  }
  if (quotaAbsorbedUnits > 0) {
    return {
      ...base,
      pricePerUnit: profile.pricing.amount,
      estimatedCost: roundCents(billableUnits * profile.pricing.amount),
      basis: "partial_quota",
    };
  }
  return {
    ...base,
    pricePerUnit: profile.pricing.amount,
    estimatedCost: roundCents(billableUnits * profile.pricing.amount),
    basis: "priced_per_unit",
  };
}

/**
 * Apply the runbook §33 $25 rule to a queue of calls. Cumulative across ALL
 * queued calls (five workers cannot each approve $24.99): any single worker's
 * decision is computed against the shared cumulative projection.
 */
export function decideSpend(
  estimates: readonly SpendEstimate[],
  options: {
    alreadySpent?: number;
    autoLimitUsd?: number;
    currency?: string;
  } = {},
): SpendDecision {
  const alreadySpent = options.alreadySpent ?? 0;
  const autoLimit = options.autoLimitUsd ?? AUTO_SPEND_LIMIT_USD;
  const currency = options.currency ?? "USD";

  if (!Number.isFinite(alreadySpent) || alreadySpent < 0) {
    throw new PricingError("alreadySpent", {
      provider: "budget",
      modelId: "decideSpend",
      kind: "reasoning",
      pricing: { unit: null, amount: null, currency, quota: null, overage: null },
      includedQuota: { units: null, resetPeriod: null, subscription: false },
    });
  }

  const currencies = new Set(estimates.map((e) => e.currency));
  if (currencies.size > 1) {
    throw new PricingError("mixed currencies", {
      provider: "budget",
      modelId: "decideSpend",
      kind: "reasoning",
      pricing: { unit: null, amount: null, currency, quota: null, overage: null },
      includedQuota: { units: null, resetPeriod: null, subscription: false },
    });
  }
  if (currencies.size === 1 && estimates[0] !== undefined && estimates[0].currency !== currency) {
    throw new PricingError("currency mismatch", {
      provider: "budget",
      modelId: "decideSpend",
      kind: "reasoning",
      pricing: { unit: null, amount: null, currency, quota: null, overage: null },
      includedQuota: { units: null, resetPeriod: null, subscription: false },
    });
  }

  if (estimates.some((e) => !isEstimable(e))) {
    return {
      allowed: false,
      requires: "approval",
      projectedSpend: null,
      currency,
      reason: "at least one call has unknown pricing — operator approval required before any spend",
    };
  }
  const projected = alreadySpent + estimates.reduce((sum, e) => sum + (e.estimatedCost ?? 0), 0);
  if (projected >= autoLimit) {
    return {
      allowed: false,
      requires: "approval",
      projectedSpend: roundCents(projected),
      currency,
      reason: `cumulative projected spend $${roundCents(projected).toFixed(2)} reaches or crosses the $${autoLimit.toFixed(2)} auto limit — approval required`,
    };
  }
  return {
    allowed: true,
    requires: "automatic",
    projectedSpend: roundCents(projected),
    currency,
    reason: `cumulative projected spend $${roundCents(projected).toFixed(2)} is below the $${autoLimit.toFixed(2)} auto limit`,
  };
}

/**
 * True when this estimate can count toward an automatic-spend decision.
 * NaN/Infinity costs are unestimable: they must block automatic spend like
 * unknown pricing does, never auto-approve (NaN >= limit is false).
 */
export function isEstimable(estimate: SpendEstimate): boolean {
  return estimate.estimatedCost !== null && Number.isFinite(estimate.estimatedCost);
}

/** Round money to cents to keep float noise out of cumulative totals. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}