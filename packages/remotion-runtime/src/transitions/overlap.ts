import type {
  ResolvedBoundary,
  ShotPlacement,
  TransitionShot,
  TransitionTimeline,
  WipeDirection,
} from "./types";

/**
 * Frame-exact overlap math for VID-009 (runbook §24, spec §21).
 *
 * All boundary math is integer frames at the composition fps — never seconds —
 * so boundary parameters can't drift from float rounding across a render.
 * Ranges are half-open: a shot occupies `[globalIn, globalOut)` with
 * `globalOut = globalIn + durationInFrames`, matching the upstream frames.mjs
 * convention preserved by VID-003 (`local_f = global_s * fps − sequence_from`).
 */

/** `cut` is instantaneous: zero overlap, regardless of any declared duration. */
export const CUT_OVERLAP_FRAMES = 0;

/** Default overlap for `crossfade` when no duration is declared. */
export const CROSSFADE_DEFAULT_DURATION_FRAMES = 12;

/** Default overlap for `wipe` when no duration is declared. */
export const WIPE_DEFAULT_DURATION_FRAMES = 10;

/** Kinds that hold both shots on screen for `overlapFrames > 0`. */
export const OVERLAP_KINDS = ["crossfade", "wipe"] as const;

/** Default overlap per kind (cut is handled by CUT_OVERLAP_FRAMES). */
const DEFAULT_OVERLAP_FRAMES = {
  crossfade: CROSSFADE_DEFAULT_DURATION_FRAMES,
  wipe: WIPE_DEFAULT_DURATION_FRAMES,
} as const;

/**
 * Resolves the declared transition at a boundary to its effective overlap in
 * frames. `cut` always resolves to 0 (a cut is instantaneous; a duration on a
 * cut is a contradiction and is clamped out). Overlap kinds fall back to their
 * catalog default when no duration is declared, and decline non-positive or
 * non-integer durations the same way — plan validation reports those as
 * issues, but resolution never throws.
 */
export function resolveOverlapFrames(
  transition: TransitionShot["transition"],
  kind: string,
): number {
  if (kind === "cut") {
    return CUT_OVERLAP_FRAMES;
  }
  const declared = transition?.durationFrames;
  if (declared !== undefined && Number.isInteger(declared) && declared > 0) {
    return declared;
  }
  if (kind === "crossfade" || kind === "wipe") {
    return DEFAULT_OVERLAP_FRAMES[kind];
  }
  return CUT_OVERLAP_FRAMES;
}

/**
 * Effectively-used overlap at a boundary. Declared overlap bigger than either
 * adjacent shot is clamped to the shorter shot: a crossfade cannot run longer
 * than the outgoing shot (nothing before it to hold) nor the incoming shot
 * (nothing after it to reveal). The clamped value is what renderers must use.
 */
export function clampOverlap(overlapFrames: number, outgoingFrames: number, incomingFrames: number): number {
  return Math.max(0, Math.min(overlapFrames, outgoingFrames, incomingFrames));
}

/**
 * Resolves a plan onto a frame-exact timeline: per-shot placement plus one
 * resolved boundary per adjacent shot pair.
 *
 * Frame accounting (in frames, all integer):
 *   globalIn(0) = 0
 *   globalIn(i) = globalOut(i-1) − overlap(i)      for i ≥ 1
 *   globalOut(i) = globalIn(i) + duration(i)
 *   total = Σ duration − Σ overlap
 *
 * A transition declared on the first shot has no outgoing shot and is ignored:
 * there is no boundary before index 0.
 */
export function planShotPlacements(
  fps: number,
  shots: readonly TransitionShot[],
): TransitionTimeline {
  const placements: ShotPlacement[] = [];
  const boundaries: ResolvedBoundary[] = [];

  if (shots.length === 0) {
    return { fps, placements, boundaries, totalDurationInFrames: 0 };
  }

  const first = shots[0]!;
  placements.push({
    shotId: first.id,
    sequenceIndex: 0,
    globalIn: 0,
    globalOut: first.durationInFrames,
    durationInFrames: first.durationInFrames,
  });

  for (let i = 1; i < shots.length; i++) {
    const outgoing = placements[i - 1]!;
    const incoming = shots[i]!;
    const kind = incoming.transition?.kind ?? "cut";
    const overlapFrames = clampOverlap(
      resolveOverlapFrames(incoming.transition, kind),
      outgoing.durationInFrames,
      incoming.durationInFrames,
    );
    const globalIn = outgoing.globalOut - overlapFrames;
    const globalOut = globalIn + incoming.durationInFrames;

    boundaries.push({
      shotIndex: i,
      outgoingShotId: outgoing.shotId,
      incomingShotId: incoming.id,
      kind,
      overlapFrames,
      overlapStart: globalIn,
      overlapEnd: outgoing.globalOut,
      direction: kind === "wipe" ? inboundWipeDirection(incoming.transition) : undefined,
    });
    placements.push({
      shotId: incoming.id,
      sequenceIndex: i,
      globalIn,
      globalOut,
      durationInFrames: incoming.durationInFrames,
    });
  }

  const totalOverlapFrames = boundaries.reduce(
    (sum, boundary) => sum + boundary.overlapFrames,
    0,
  );
  const totalDurationInFrames =
    shots.reduce((sum, shot) => sum + shot.durationInFrames, 0) - totalOverlapFrames;

  return { fps, placements, boundaries, totalDurationInFrames };
}

function inboundWipeDirection(
  transition: TransitionShot["transition"],
): WipeDirection | undefined {
  // Only reachable for wipe kind (validated upstream); keep the guard local so
  // plan assembly never fabricates a direction for other kinds.
  return transition?.kind === "wipe" ? transition.direction : undefined;
}
