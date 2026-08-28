import type { TransitionKind, WipeDirection } from "./types";
import {
  CROSSFADE_DEFAULT_DURATION_FRAMES,
  CUT_OVERLAP_FRAMES,
  WIPE_DEFAULT_DURATION_FRAMES,
} from "./overlap";

/**
 * Transition catalog for VID-009 (runbook §24, spec §21).
 *
 * Minimal viable catalog: `cut`, `crossfade`, `wipe`. Declared on plan shots
 * via `TransitionSpec.kind`; unknown kinds are rejected by validation, not
 * silently coerced, so a plan carrying a future kind fails loudly at build
 * time rather than rendering the wrong boundary.
 */

export interface TransitionDefinition {
  readonly kind: TransitionKind;
  /** Human-readable description for docs/QC. */
  readonly description: string;
  /**
   * Default overlap in frames when the plan declares no explicit duration.
   * `cut` is always 0 regardless.
   */
  readonly defaultDurationFrames: number;
}

export const TRANSITION_CATALOG = {
  cut: {
    kind: "cut",
    description: "Instant switch. Outgoing shot ends on the frame the incoming shot begins; overlap is always 0.",
    defaultDurationFrames: CUT_OVERLAP_FRAMES,
  },
  crossfade: {
    kind: "crossfade",
    description: "Outgoing and incoming shots dissolve into one another across the overlap window.",
    defaultDurationFrames: CROSSFADE_DEFAULT_DURATION_FRAMES,
  },
  wipe: {
    kind: "wipe",
    description:
      "Incoming shot is revealed across the frame in one direction over the overlap window.",
    defaultDurationFrames: WIPE_DEFAULT_DURATION_FRAMES,
  },
} as const satisfies Record<TransitionKind, TransitionDefinition>;

/** All catalog kinds, for iteration and exhaustive checks. */
export const TRANSITION_KINDS = Object.freeze(
  Object.keys(TRANSITION_CATALOG),
) as readonly TransitionKind[];

/** True when `kind` is a known catalog entry. */
export function isTransitionKind(value: string): value is TransitionKind {
  return (TRANSITION_KINDS as readonly string[]).includes(value);
}

/** Default overlap in frames for a kind; `cut` yields 0. */
export function defaultDurationFramesFor(kind: TransitionKind): number {
  return TRANSITION_CATALOG[kind].defaultDurationFrames;
}

/** Valid wipe directions, for validation and exhaustive rendering switch. */
export const WIPE_DIRECTIONS: readonly WipeDirection[] = [
  "left-to-right",
  "right-to-left",
  "top-to-bottom",
  "bottom-to-top",
];

/** True when `direction` names a known wipe direction. */
export function isWipeDirection(value: string): value is WipeDirection {
  return (WIPE_DIRECTIONS as readonly string[]).includes(value);
}
