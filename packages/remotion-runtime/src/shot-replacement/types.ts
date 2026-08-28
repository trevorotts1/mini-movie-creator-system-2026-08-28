/**
 * VID-013 — Selective shot replacement (spec §21, §32).
 *
 * The episodic timeline is an ordered sequence of shot segments. Each segment
 * carries its own INPUTS (layer kind, canonical asset reference, trim,
 * camera motion, caption/audio references). Replacing one shot swaps that
 * segment's inputs — every other segment passes through untouched, so no
 * unaffected shot is ever regenerated (spec §20: "targeted repair/regeneration
 * of the affected shot only — never blind whole-episode regeneration").
 *
 * This module is pure: it computes plans, replacements, and diffs. Render
 * execution (Remotion) and provider generation live in their own lanes and
 * consume the results. Story/script text is untrusted data and never reaches
 * this module as anything but inert field values (spec §29).
 */

/** The four visual layer kinds (spec §22). */
export const SHOT_LAYER_KINDS = [
  "generated-video",
  "still-motion",
  "stock",
  "graphics",
] as const;

export type ShotLayerKind = (typeof SHOT_LAYER_KINDS)[number];

/**
 * Per-shot render inputs. Two shots with equal inputs render identically —
 * the composition diff treats inputs as the unit of change.
 */
export interface ShotInputs {
  readonly layerKind: ShotLayerKind;
  /**
   * Canonical asset reference (GHL URL / local library path token, spec §19
   * DB record, never a bare filename). Absent for native graphics shots.
   */
  readonly assetRef?: string;
  /** Source-media trim window, in source frames. Absent = full asset. */
  readonly trimInFrames?: number;
  readonly trimOutFrames?: number;
  readonly cameraMotion?: string;
  readonly captionRefs?: readonly string[];
  readonly audioRefs?: readonly string[];
}

/** One shot slot in the episodic timeline (spec §12 identity + §21 render inputs). */
export interface ShotSegment {
  readonly shotId: string;
  readonly sceneId: string;
  readonly sequenceIndex: number;
  readonly durationInFrames: number;
  readonly inputs: ShotInputs;
}

/** Ordered shot plan for one episode. Segments MUST have unique shotIds. */
export interface EpisodicShotPlan {
  readonly episodeId: string;
  readonly fps: number;
  /** Ordered by sequenceIndex ascending. */
  readonly segments: readonly ShotSegment[];
}

/** A segment plus its derived timeline placement (frames, not seconds). */
export interface TimedSegment {
  readonly segment: ShotSegment;
  readonly startFrame: number;
  /** Exclusive end frame: startFrame + durationInFrames. */
  readonly endFrame: number;
}

/**
 * Requested replacement for exactly one shot. The new asset and/or trim is
 * the point — anything omitted stays as the existing shot rendered it.
 */
export interface ShotReplacement {
  /** The only shot this replacement may touch. */
  readonly shotId: string;
  /** New canonical asset reference (spec §19). */
  readonly assetRef?: string;
  /** Swap the visual layer kind (e.g. generated-video -> still-motion, §22). */
  readonly layerKind?: ShotLayerKind;
  readonly trimInFrames?: number;
  readonly trimOutFrames?: number;
  readonly cameraMotion?: string;
  /** Replaces the caption/audio reference lists wholesale when provided. */
  readonly captionRefs?: readonly string[];
  readonly audioRefs?: readonly string[];
  /**
   * "fit-slot" (default): the shot keeps its existing slot duration and the
   * trim window is fitted to supply exactly that many output frames.
   * "explicit": the shot's duration becomes `durationInFrames` and downstream
   * start frames reflow — still no other shot's inputs change.
   */
  readonly durationPolicy?: "fit-slot" | "explicit";
  /** Required when durationPolicy is "explicit". */
  readonly durationInFrames?: number;
}

/** Result of applying one replacement. */
export interface ReplaceShotResult {
  readonly plan: EpisodicShotPlan;
  readonly replaced: ShotSegment;
  readonly diff: CompositionDiff;
}

/**
 * Structural diff between two plans of the same episode. This is the proof
 * artifact for spec §32: after a targeted replacement, `changedShotIds`
 * contains ONLY the targeted shot — everything else is unchanged or merely
 * reflowed (derived start-frame shift, identical inputs, no regeneration).
 */
export interface CompositionDiff {
  /** Shots whose inputs or duration changed. */
  readonly changedShotIds: readonly string[];
  /** Shots byte-identical in inputs, duration, and derived placement. */
  readonly unchangedShotIds: readonly string[];
  /** Inputs+duration identical, but derived start frame shifted. */
  readonly reflowedShotIds: readonly string[];
  readonly totalDurationBefore: number;
  readonly totalDurationAfter: number;
  readonly durationDelta: number;
}

/** Scope plan for retrying one failed shot (spec §20 retry policy). */
export interface RetryShotPlan {
  readonly shotId: string;
  readonly attempt: number;
  readonly reason?: string;
  /**
   * Exactly `[shotId]` — the retry scope is one shot by construction.
   * Downstream QC can assert this to block whole-episode regeneration.
   */
  readonly regeneratesShotIds: readonly string[];
  /** Every other shot, plan order — none of these are regenerated. */
  readonly preservedShotIds: readonly string[];
}

/** Machine-checkable failure codes for ShotReplacementError. */
export type ShotReplacementErrorCode =
  | "unknown-shot"
  | "duplicate-shot"
  | "invalid-plan"
  | "invalid-trim"
  | "insufficient-source"
  | "invalid-duration"
  | "invalid-replacement"
  | "incomparable-plans";

/** Thrown for every invalid replacement/trim/diff input. */
export class ShotReplacementError extends Error {
  readonly code: ShotReplacementErrorCode;

  constructor(code: ShotReplacementErrorCode, message: string) {
    super(message);
    this.name = "ShotReplacementError";
    this.code = code;
  }
}
