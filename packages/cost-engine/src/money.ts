/**
 * USD money as integer cents (spec §4: the $25.00 boundary must be exact).
 * Every ledger computation happens in cents; USD numbers only at the edge.
 * Cents stay under `Number.MAX_SAFE_INTEGER` for any realistic budget.
 */

/** Throw instead of silently rounding when a caller sends sub-cent precision. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** USD number -> integer cents. Rejects values with sub-cent precision. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new MoneyError(`USD amount must be finite, got ${usd}`);
  }
  if (usd < 0) {
    throw new MoneyError(`USD amount must be non-negative, got ${usd}`);
  }
  const cents = Math.round(usd * 100);
  // Math.round(x*100) === x*100 only when x had at most 2 decimal places
  // (within double precision). Anything else is a caller bug. The tolerance
  // scales with magnitude: doubles cannot resolve cents near 2^53/100, so a
  // fixed epsilon would falsely reject legitimate 2-decimal values there
  // (e.g. 10_000_000_000_000.37 — the product itself drifts by ~0.125).
  const product = usd * 100;
  const tolerance = Math.max(1e-6, Math.abs(product) * Number.EPSILON * 8);
  if (Math.abs(cents - product) > tolerance) {
    throw new MoneyError(`USD amount has sub-cent precision: ${usd}`);
  }
  return cents;
}

/** Integer cents -> USD number for API responses. */
export function centsToUsd(cents: number): number {
  return cents / 100;
}