import {
  assertLicenseSafe,
  assertStockAllowed,
  evaluateStockGuard,
  StockLicenseError,
  StockPolicyViolationError,
  toStockGuardInput,
} from "./guard.js";
import {
  createLicenseSafePlaceholder,
  isLicenseSafe,
  isStockAllowedPurpose,
  STOCK_ALLOWED_PURPOSES,
  type StockClip,
  type StockPlacementCandidate,
  type StockShotPlacement,
} from "./types.js";

/** FPS used to convert seconds to frames (Remotion default). */
const DEFAULT_FPS = 30;

export { STOCK_ALLOWED_PURPOSES };
export type { StockClip, StockPlacementCandidate, StockShotPlacement };

/**
 * Stock/B-roll layer (spec §22): place stock clips for generic establishing /
 * B-roll shots ONLY. Shots depicting recurring main characters or with
 * non-generic purposes are rejected — the layer never places stock as a
 * substitute for generated character video.
 *
 * Candidates whose `visualSource` is not `stock_broll` are silently skipped:
 * they belong to the other three §22 layers.
 */
export function placeStockShots(
  candidates: readonly StockPlacementCandidate[],
  clipsByShotId: ReadonlyMap<string, StockClip>,
  recurringMainCharacterIds: readonly string[],
  options: { readonly fps?: number } = {},
): StockShotPlacement[] {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`fps must be a positive finite number, got ${fps}`);
  }

  const placements: StockShotPlacement[] = [];
  for (const candidate of candidates) {
    if (candidate.visualSource !== "stock_broll") continue;
    if (!isStockAllowedPurpose(candidate.purpose)) continue;

    const clip = clipsByShotId.get(candidate.shotId);
    if (!clip) continue;

    assertStockAllowed(
      toStockGuardInput(candidate),
      recurringMainCharacterIds,
      candidate.shotId,
    );

    assertLicenseSafe(clip, candidate.shotId);

    const start = candidate.startSeconds ?? 0;
    placements.push({
      shotId: candidate.shotId,
      clip,
      startFrame: Math.round(start * fps),
      durationInFrames: Math.round(clip.durationSeconds * fps),
    });
  }
  return placements;
}

export {
  assertLicenseSafe,
  assertStockAllowed,
  evaluateStockGuard,
  StockLicenseError,
  StockPolicyViolationError,
  toStockGuardInput,
};
export type {
  StockAdapter,
  StockGuardInput,
  StockGuardResult,
} from "./guard.js";
export { createStockAdapter } from "./adapters.js";
export {
  createLicenseSafePlaceholder,
  isLicenseSafe,
} from "./types.js";
export type {
  ShotPurpose,
  StockAcquisitionMethod,
  StockAllowedPurpose,
  StockLicenseInfo,
  StockLicenseKind,
  StockPolicyViolationReason,
  StockProviderId,
  VisualSourceType,
} from "./types.js";