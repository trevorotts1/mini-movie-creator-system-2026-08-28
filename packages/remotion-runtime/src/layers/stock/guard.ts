import type {
  StockClip,
  StockPlacementCandidate,
  StockProviderId,
} from "./types.js";

/**
 * Stock/B-roll guard (spec §22): stock footage is for generic establishing /
 * B-roll shots ONLY — never a substitute for recurring main characters.
 *
 * The guard is the last line of defense before timeline placement: even if an
 * upstream planner mislabels a shot, placement is refused when the shot
 * depicts recurring main characters or has a non-generic purpose.
 */
export interface StockGuardInput {
  /** Character IDs depicted in the shot. */
  readonly characterIds: readonly string[];
  /** Generic purposes only ("establishing", "broll"). */
  readonly purpose: string;
}

/**
 * Guard input derived from a placement candidate: only candidates whose
 * visual source is `stock_broll` reach the guard.
 */
export function toStockGuardInput(candidate: StockPlacementCandidate): StockGuardInput {
  return { characterIds: candidate.characterIds, purpose: candidate.purpose };
}

/** Result of the stock guard check. */
export interface StockGuardResult {
  readonly allowed: boolean;
  readonly reason?: "recurring_main_character" | "purpose_not_generic";
  /** Character IDs that triggered the recurring-main-character rejection. */
  readonly offendingCharacterIds?: readonly string[];
}

/**
 * Validate a shot against the stock policy. Pure function; throws nothing.
 *
 * Rules (spec §22):
 * 1. Purpose must be a generic one (`establishing` or `broll`).
 * 2. The shot must not depict any recurring main character.
 */
export function evaluateStockGuard(
  input: StockGuardInput,
  recurringMainCharacterIds: readonly string[],
): StockGuardResult {
  if (input.purpose !== "establishing" && input.purpose !== "broll") {
    return { allowed: false, reason: "purpose_not_generic" };
  }

  const recurring = new Set(recurringMainCharacterIds);
  const offending = input.characterIds.filter((id) => recurring.has(id));
  if (offending.length > 0) {
    return {
      allowed: false,
      reason: "recurring_main_character",
      offendingCharacterIds: offending,
    };
  }

  return { allowed: true };
}

/** Error thrown when stock placement violates the §22 policy. */
export class StockPolicyViolationError extends Error {
  readonly reason: NonNullable<StockGuardResult["reason"]>;
  readonly shotId: string;
  readonly offendingCharacterIds: readonly string[];

  constructor(
    reason: NonNullable<StockGuardResult["reason"]>,
    shotId: string,
    offendingCharacterIds: readonly string[] = [],
  ) {
    const message =
      reason === "recurring_main_character"
        ? `Stock/B-roll refused for shot "${shotId}": stock footage must never substitute for recurring main characters (spec §22); offending: ${offendingCharacterIds.join(", ")}`
        : `Stock/B-roll refused for shot "${shotId}": non-generic purpose is not a generic establishing/B-roll purpose (spec §22)`;
    super(message);
    this.name = "StockPolicyViolationError";
    this.reason = reason;
    this.shotId = shotId;
    this.offendingCharacterIds = offendingCharacterIds;
  }
}

/** Assert-style wrapper around `evaluateStockGuard`. Throws on violation. */
export function assertStockAllowed(
  input: StockGuardInput,
  recurringMainCharacterIds: readonly string[],
  shotId: string,
): void {
  const result = evaluateStockGuard(input, recurringMainCharacterIds);
  if (!result.allowed) {
    throw new StockPolicyViolationError(
      result.reason as NonNullable<StockGuardResult["reason"]>,
      shotId,
      result.offendingCharacterIds ?? [],
    );
  }
}

/** Minimal stock adapter contract (Pexels/Pixabay/local implementations). */
export interface StockAdapter {
  readonly providerId: StockProviderId;
  /** Search stock footage; returns resolved clips, never character media. */
  search(query: string, options?: { readonly limit?: number }): Promise<StockClip[]>;
}