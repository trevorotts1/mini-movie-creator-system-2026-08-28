/**
 * Shot cost estimation — DIR-010 (spec §12 `estimated_cost`).
 *
 * Estimates the paid cost of one shot from the selected model's pricing
 * slice and the shot's target duration. UNKNOWN pricing (null unit or
 * amount) yields null cost — never invented (spec §5 doctrine applied to
 * money). Billing unit interpretation:
 *   - "usd-per-output-second-*" / "usd-per-second-*": amount × seconds
 *   - any other/unknown unit: null (cannot honestly derive a number)
 */

import type { VideoModelConstraints } from "./types.js";

/**
 * Estimated USD cost for a shot of `durationSeconds` under the model's
 * pricing, or null when pricing is unknown/unusable.
 */
export function estimateShotCost(
  durationSeconds: number,
  constraints: VideoModelConstraints,
): number | null {
  const pricing = constraints.pricing;
  if (!pricing || pricing.amount === null || pricing.unit === null) return null;
  if (!isPerSecondUnit(pricing.unit)) return null;
  return round4(pricing.amount * durationSeconds);
}

function isPerSecondUnit(unit: string): boolean {
  return unit.startsWith("usd-per-output-second") || unit.startsWith("usd-per-second");
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}