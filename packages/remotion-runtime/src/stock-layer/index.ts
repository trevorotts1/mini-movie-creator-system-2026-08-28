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

    // Policy gate FIRST: a stock_broll-typed shot with a non-generic purpose
    // or a recurring main character is refused loudly, never silently dropped
    // from the timeline (spec §22).
    assertStockAllowed(
      toStockGuardInput(candidate),
      recurringMainCharacterIds,
      candidate.shotId,
    );

    const clip = clipsByShotId.get(candidate.shotId);
    if (!clip) continue;

    assertLicenseSafe(clip, candidate.shotId);

    const start = candidate.startSeconds ?? 0;
    if (!Number.isFinite(start) || start < 0) {
      throw new RangeError(
        `startSeconds must be a non-negative finite number for shot "${candidate.shotId}", got ${start}`,
      );
    }
    if (!Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) {
      throw new RangeError(
        `clip "${clip.id}" for shot "${candidate.shotId}" must have a positive finite durationSeconds, got ${clip.durationSeconds}`,
      );
    }
    const durationInFrames = Math.round(clip.durationSeconds * fps);
    if (durationInFrames < 1) {
      throw new RangeError(
        `clip "${clip.id}" for shot "${candidate.shotId}" is shorter than one frame at ${fps} fps (${clip.durationSeconds}s)`,
      );
    }

    placements.push({
      shotId: candidate.shotId,
      clip,
      startFrame: Math.round(start * fps),
      durationInFrames,
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
export {
  createPexelsAdapter,
  createPixabayAdapter,
  createStockAdapter,
  STOCK_ADAPTER_FACTORIES,
} from "./adapters.js";
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