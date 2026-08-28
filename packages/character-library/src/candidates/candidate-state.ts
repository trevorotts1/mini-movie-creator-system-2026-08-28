/**
 * Character candidate state machine (spec §9 asset states + §9 3-candidate UX).
 *
 * Asset states: DRAFT → REVIEW → APPROVED → CANONICAL → RETIRED (plus REJECTED).
 * REJECTED is terminal: rejected candidates are never used later and are never
 * selectable. Lock/canonical transitions (APPROVED → CANONICAL) are owned by
 * CHAR-005; the transition table already reserves them so every consumer shares
 * one machine.
 */

export const ASSET_STATES = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
  "REJECTED",
] as const;

export type AssetState = (typeof ASSET_STATES)[number];

/**
 * The one transition table. A state not listed as a target of the current
 * state is illegal. REJECTED and RETIRED are terminal (no outgoing edges).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<AssetState, readonly AssetState[]>> = {
  DRAFT: ["REVIEW", "REJECTED"],
  REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["CANONICAL", "RETIRED"],
  CANONICAL: ["RETIRED"],
  RETIRED: [],
  REJECTED: [],
};

export class CandidateStateError extends Error {
  readonly from: AssetState;
  readonly to: AssetState;

  constructor(from: AssetState, to: AssetState, detail?: string) {
    super(
      `Illegal candidate state transition ${from} -> ${to}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "CandidateStateError";
    this.from = from;
    this.to = to;
  }
}

export function isTransitionAllowed(from: AssetState, to: AssetState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AssetState, to: AssetState): void {
  if (!isTransitionAllowed(from, to)) {
    throw new CandidateStateError(from, to);
  }
}

/**
 * Selectability rule (spec §9): only candidates presented for review are
 * pickable. DRAFT candidates must be presented first; REJECTED candidates are
 * terminal and never selectable again, across rounds.
 */
export function isSelectable(state: AssetState): boolean {
  return state === "REVIEW";
}