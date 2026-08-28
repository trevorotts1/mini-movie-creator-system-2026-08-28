/**
 * Stock/B-roll layer types (spec §22).
 *
 * Spec §22 — four visual types per shot decision; stock/B-roll is type 3:
 * generic establishing/B-roll only, NEVER a substitute for recurring main
 * characters. Adapters (Pexels/Pixabay) are optional and stubbed.
 */

/** The four visual source types per spec §22. */
export type VisualSourceType =
  | "generated_character_video"
  | "ai_still_motion"
  | "stock_broll"
  | "native_graphics";

/**
 * Shot purpose. Only generic purposes (in `STOCK_ALLOWED_PURPOSES`) may use
 * stock footage; character/dialogue/graphic purposes must come from the other
 * three visual types.
 */
export type ShotPurpose =
  | "establishing"
  | "broll"
  | "character_action"
  | "dialogue"
  | "graphics_overlay";

/** Purposes for which stock/B-roll is allowed (spec §22: generic only). */
export const STOCK_ALLOWED_PURPOSES = ["establishing", "broll"] as const;
export type StockAllowedPurpose = (typeof STOCK_ALLOWED_PURPOSES)[number];

export function isStockAllowedPurpose(purpose: ShotPurpose): purpose is StockAllowedPurpose {
  return (STOCK_ALLOWED_PURPOSES as readonly string[]).includes(purpose);
}

/** Recognized stock providers. `local` covers pre-cleared in-repo B-roll. */
export type StockProviderId = "pexels" | "pixabay" | "local";

/** A resolved stock/B-roll clip ready for timeline placement. */
export interface StockClip {
  readonly id: string;
  readonly providerId: StockProviderId;
  readonly url: string;
  readonly durationSeconds: number;
  readonly width?: number;
  readonly height?: number;
  readonly attribution?: string;
}

/**
 * A shot offered to the stock layer for placement. Shots whose
 * `visualSource` is not `stock_broll` are ignored by this layer (they belong
 * to the generated/still/graphics layers).
 */
export interface StockPlacementCandidate {
  readonly shotId: string;
  readonly visualSource: VisualSourceType;
  readonly purpose: ShotPurpose;
  /** Character IDs depicted in the shot (empty for pure establishing shots). */
  readonly characterIds: readonly string[];
  /** Desired start on the episode timeline, in seconds. Defaults to 0. */
  readonly startSeconds?: number;
}

/** A stock clip placed on the episode timeline (frames, Remotion convention). */
export interface StockShotPlacement {
  readonly shotId: string;
  readonly clip: StockClip;
  readonly startFrame: number;
  readonly durationInFrames: number;
}

/** Policy violation reasons for `StockPolicyViolationError`. */
export type StockPolicyViolationReason =
  | "recurring_main_character"
  | "purpose_not_generic";