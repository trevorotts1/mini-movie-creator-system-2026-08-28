/**
 * Transition plan-data types for MMCS episodic timelines (runbook §24 VID-009,
 * spec §21).
 *
 * Transitions are declared on the *incoming* shot: `shots[i].transition`
 * describes the boundary between shot i-1 (outgoing) and shot i (incoming).
 * The first shot's `transition`, if present, is ignored (nothing precedes it).
 *
 * Placement follows the upstream frames.mjs convention preserved by VID-003:
 * frames are integers at the composition fps, spans are half-open
 * `[globalIn, globalOut)`, and `globalOut = globalIn + durationInFrames`.
 *
 * Self-contained by design: VID-003's shot timeline abstraction is a sibling
 * task; these types are deliberately local so transitions never block on it,
 * and a later integration layer can map VID-003 shot sequences onto
 * `TransitionPlan` without changing this module's contract.
 */

/** Frame-accurate shot as it appears in an episode plan. */
export interface TransitionShot {
  /** Stable shot identifier from the plan (e.g. "sc1-sh3"). */
  readonly id: string;
  /** Shot length in frames at the composition fps. Must be a positive integer. */
  readonly durationInFrames: number;
  /**
   * Transition used at the boundary INTO this shot (from the previous shot).
   * Omitted or `undefined` means the catalog default (`cut`, zero overlap).
   */
  readonly transition?: TransitionSpec;
}

/** A declared transition: catalog kind plus optional overlap override. */
export interface TransitionSpec {
  /** Catalog kind: `cut`, `crossfade`, or `wipe` (extensible via registry). */
  readonly kind: TransitionKind;
  /**
   * Overlap length in frames the transition holds across the boundary.
   * Must be a positive integer for overlap kinds; ignored (forced 0) for
   * `cut`. Omitted uses the kind's default duration.
   */
  readonly durationFrames?: number;
  /** Wipe direction. Required for `wipe`, ignored otherwise. */
  readonly direction?: WipeDirection;
}

/** Identifiers in the transition catalog. */
export type TransitionKind = "cut" | "crossfade" | "wipe";

/** Direction an incoming frame is revealed across a wipe. */
export type WipeDirection = "left-to-right" | "right-to-left" | "top-to-bottom" | "bottom-to-top";

/** Full transition plan for one episode/sequence. */
export interface TransitionPlan {
  /** Composition fps. Frames are exact at this rate (no seconds rounding). */
  readonly fps: number;
  /** Shots in playback order. */
  readonly shots: readonly TransitionShot[];
}

/**
 * Where a shot lands on the assembled timeline after overlap math.
 * `globalIn` is the first frame the shot occupies; `globalOut` is exclusive.
 */
export interface ShotPlacement {
  readonly shotId: string;
  /** 0-based position in the plan's shot list. */
  readonly sequenceIndex: number;
  readonly globalIn: number;
  /** Exclusive: `globalIn + durationInFrames`. */
  readonly globalOut: number;
  readonly durationInFrames: number;
}

/** One resolved shot boundary and its transition. */
export interface ResolvedBoundary {
  /** Index of the INCOMING shot (boundary sits between index-1 and index). */
  readonly shotIndex: number;
  readonly outgoingShotId: string;
  readonly incomingShotId: string;
  readonly kind: TransitionKind;
  /** Frames both shots are on screen simultaneously. 0 for `cut`. */
  readonly overlapFrames: number;
  /** First frame of the overlap window (== incoming shot's globalIn). */
  readonly overlapStart: number;
  /** Exclusive end of the overlap window (== outgoing shot's globalOut). */
  readonly overlapEnd: number;
  /** Wipe direction, only for `wipe` kind. */
  readonly direction?: WipeDirection;
}

/** Result of assembling a plan onto a frame-exact timeline. */
export interface TransitionTimeline {
  readonly fps: number;
  readonly placements: readonly ShotPlacement[];
  /** Boundaries in shot order; only boundaries between two shots. */
  readonly boundaries: readonly ResolvedBoundary[];
  /** Sum of shot durations minus sum of overlap frames. */
  readonly totalDurationInFrames: number;
}