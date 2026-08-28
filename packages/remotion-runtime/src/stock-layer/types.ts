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

/** License posture of a stock clip. Only license-safe clips may be placed. */
export type StockLicenseKind =
  | "pexels-license"
  | "pixabay-license"
  | "cc0"
  | "owned"
  | "unknown";

/** How the clip entered the project (media provenance, spec §19/§29). */
export type StockAcquisitionMethod =
  | "adapter-search"
  | "manual-download"
  | "placeholder";

/** Per-clip license provenance — required before timeline placement. */
export interface StockLicenseInfo {
  /** License kind. `unknown` clips are refused by the license gate. */
  readonly kind: StockLicenseKind;
  /** Human-readable attribution/credit line to render or log. */
  readonly attribution?: string;
  /** Canonical license page (provider license text, CC0 deed, or receipt). */
  readonly licenseUrl?: string;
  /** Provider page the clip was downloaded from. */
  readonly sourceUrl?: string;
  /** SHA-256 of the downloaded binary, for archival/provenance (§19). */
  readonly sha256?: string;
  /** ISO-8601 timestamp of the license/download check. */
  readonly verifiedAt?: string;
}

/**
 * A resolved stock/B-roll clip ready for timeline placement. Carries license
 * provenance (§19/§29); clips without a `license` are refused by
 * `assertLicenseSafe`.
 */
export interface StockClip {
  readonly id: string;
  readonly providerId: StockProviderId;
  readonly url: string;
  readonly durationSeconds: number;
  readonly width?: number;
  readonly height?: number;
  readonly attribution?: string;
  readonly license: StockLicenseInfo;
  readonly acquisition?: StockAcquisitionMethod;
}

/**
 * License-safe placeholder clip: a structured record standing in for a real
 * download. No binary is committed — `url` points at the provider page to
 * license from; provenance marks it `placeholder` + `unknown` so the license
 * gate (and QC) can tell it apart from a cleared clip.
 */
export function createLicenseSafePlaceholder(input: {
  readonly id: string;
  readonly providerId: StockProviderId;
  readonly sourceUrl: string;
  readonly durationSeconds: number;
  readonly attribution?: string;
  readonly width?: number;
  readonly height?: number;
}): StockClip {
  return {
    id: input.id,
    providerId: input.providerId,
    url: input.sourceUrl,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    attribution: input.attribution,
    acquisition: "placeholder",
    license: {
      kind: "unknown",
      attribution: input.attribution,
      sourceUrl: input.sourceUrl,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * License gate: refuse clips without provenance (`license.kind === "unknown"`
 * or a missing license record). Pure predicate; throws nothing.
 */
export function isLicenseSafe(clip: StockClip | undefined): boolean {
  if (!clip) return false;
  return Boolean(clip.license) && clip.license.kind !== "unknown";
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