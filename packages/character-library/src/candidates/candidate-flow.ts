/**
 * Candidate generation flow (spec §9 3-candidate UX, spec §3 gate 3).
 *
 * Flow: new-character request -> createCandidatesForRound (3 DRAFT) ->
 * presentRound (3 REVIEW) -> selection 1/2/3 -> approveSelected; or
 * TRY_AGAIN -> rejectRound (round -> REJECTED, terminal) -> presentRound of
 * three NEW candidates (next round). Rejected candidates are kept only as
 * draft/rejected history and are never selectable again.
 *
 * Pure domain logic: no DB, no provider calls, no clock. Callers pass `now`.
 */

import {
  assertTransition,
  isSelectable,
  type AssetState,
} from "./candidate-state.js";
import {
  CANDIDATES_PER_ROUND,
  SELECTION_CHOICES,
  createCandidatesForRound,
  requestIdOf,
  requireSelectable,
  type CharacterCandidate,
  type CharacterCandidateRequest,
  type SelectionChoice,
} from "./candidate.js";

export interface CandidateFlowEvent {
  readonly at: string;
  readonly kind:
    | "REQUEST_CREATED"
    | "ROUND_CREATED"
    | "ROUND_PRESENTED"
    | "CANDIDATE_REJECTED"
    | "CANDIDATE_SELECTED"
    | "ROUND_REJECTED"
    | "TRY_AGAIN";
  readonly requestId: string;
  readonly candidateIds: readonly string[];
  readonly detail: string;
}

export interface CandidateFlowState {
  readonly request: CharacterCandidateRequest;
  /** Every candidate ever created for this request, oldest first. */
  readonly candidates: readonly CharacterCandidate[];
  /** Round currently awaiting selection, or null when resolved/none open. */
  readonly openRound: number | null;
  /** Candidate chosen and approved (state APPROVED), or null. */
  readonly selectedCandidateId: string | null;
  /** Round number whose selection resolved the request, or null. */
  readonly selectedRound: number | null;
  readonly events: readonly CandidateFlowEvent[];
}

export class CandidateFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateFlowError";
  }
}

const EMPTY_STATE: Omit<CandidateFlowState, "request" | "candidates"> = {
  openRound: null,
  selectedCandidateId: null,
  selectedRound: null,
  events: [],
};

/** Start a flow from a new-character request. No candidates exist yet. */
export function startCandidateFlow(
  request: CharacterCandidateRequest,
  now: string,
): CandidateFlowState {
  return {
    request,
    candidates: [],
    ...EMPTY_STATE,
    events: [
      {
        at: now,
        kind: "REQUEST_CREATED",
        requestId: requestIdOf(request),
        candidateIds: [],
        detail: `new character requested: ${request.displayName}`,
      },
    ],
  };
}

function replaceCandidate(
  state: CandidateFlowState,
  candidateId: string,
  nextState: AssetState,
  at: string,
  reason: string,
): CandidateFlowState {
  const candidates = state.candidates.map((candidate) => {
    if (candidate.candidateId !== candidateId) {
      return candidate;
    }
    assertTransition(candidate.state, nextState);
    return {
      ...candidate,
      state: nextState,
      updatedAt: at,
      lastTransitionReason: reason,
    };
  });
  return { ...state, candidates };
}

function pushEvent(
  state: CandidateFlowState,
  event: CandidateFlowEvent,
): CandidateFlowState {
  return { ...state, events: [...state.events, event] };
}

/** Generate the three DRAFT candidates for `round`. */
export function createRound(
  state: CandidateFlowState,
  round: number,
  now: string,
): CandidateFlowState {
  if (state.selectedCandidateId !== null) {
    throw new CandidateFlowError(
      `request already resolved with ${state.selectedCandidateId}; cannot create round ${round}`,
    );
  }
  if (state.openRound !== null) {
    throw new CandidateFlowError(
      `round ${state.openRound} is still open; reject it via tryAgain before creating round ${round}`,
    );
  }
  if (state.candidates.some((candidate) => candidate.round === round)) {
    throw new CandidateFlowError(`round ${round} already exists for this request`);
  }
  if (round !== 1 && !state.candidates.some((c) => c.round === round - 1)) {
    throw new CandidateFlowError(
      `round ${round} cannot be created before round ${round - 1}`,
    );
  }
  const created = createCandidatesForRound(state.request, round, now);
  const withCreated: CandidateFlowState = {
    ...state,
    candidates: [...state.candidates, ...created],
    openRound: round,
    events: [
      ...state.events,
      {
        at: now,
        kind: "ROUND_CREATED",
        requestId: requestIdOf(state.request),
        candidateIds: created.map((c) => c.candidateId),
        detail: `round ${round}: ${CANDIDATES_PER_ROUND} candidates created as DRAFT`,
      },
    ],
  };
  return withCreated;
}

/** Move an open round's candidates DRAFT -> REVIEW (they become selectable). */
export function presentRound(
  state: CandidateFlowState,
  round: number,
  now: string,
): CandidateFlowState {
  if (state.openRound !== round) {
    throw new CandidateFlowError(
      `round ${round} is not the open round (open: ${state.openRound})`,
    );
  }
  const roundCandidates = state.candidates.filter((c) => c.round === round);
  if (roundCandidates.length !== CANDIDATES_PER_ROUND) {
    throw new CandidateFlowError(
      `round ${round} has ${roundCandidates.length} candidates, expected ${CANDIDATES_PER_ROUND}`,
    );
  }
  if (!roundCandidates.every((c) => c.state === "DRAFT")) {
    throw new CandidateFlowError(`round ${round} was already presented`);
  }
  let next = state;
  for (const candidate of roundCandidates) {
    next = replaceCandidate(next, candidate.candidateId, "REVIEW", now, "presented to user");
  }
  return pushEvent(next, {
    at: now,
    kind: "ROUND_PRESENTED",
    requestId: requestIdOf(state.request),
    candidateIds: roundCandidates.map((c) => c.candidateId),
    detail: `round ${round} presented as Character 1/2/3`,
  });
}

/**
 * Handle the user's gate choice for the open round.
 * - "1" | "2" | "3": select that slot's candidate (REVIEW -> APPROVED) and
 *   reject the two siblings. Flow is resolved.
 * - "TRY_AGAIN": reject every candidate of the open round (terminal REJECTED)
 *   and mark the round closed; caller then creates + presents the next round.
 */
export function applySelection(
  state: CandidateFlowState,
  choice: SelectionChoice,
  now: string,
  reason = "",
): CandidateFlowState {
  if (!SELECTION_CHOICES.includes(choice)) {
    throw new CandidateFlowError(
      `invalid selection choice: ${choice}; expected one of: ${SELECTION_CHOICES.join(", ")}`,
    );
  }
  if (state.openRound === null) {
    throw new CandidateFlowError("no open round to apply a selection to");
  }
  const round = state.openRound;
  const roundCandidates = state.candidates.filter((c) => c.round === round);

  if (choice === "TRY_AGAIN") {
    let next = state;
    for (const candidate of roundCandidates) {
      next = replaceCandidate(
        next,
        candidate.candidateId,
        "REJECTED",
        now,
        reason || "user chose Try Again",
      );
    }
    next = pushEvent(next, {
      at: now,
      kind: "TRY_AGAIN",
      requestId: requestIdOf(state.request),
      candidateIds: roundCandidates.map((c) => c.candidateId),
      detail: `round ${round} rejected via Try Again`,
    });
    return { ...next, openRound: null };
  }

  const slot = Number.parseInt(choice, 10) as 1 | 2 | 3;
  const chosen = roundCandidates.find((c) => c.slot === slot);
  if (!chosen) {
    throw new CandidateFlowError(`round ${round} has no candidate in slot ${choice}`);
  }
  requireSelectable(chosen);

  let next = state;
  for (const candidate of roundCandidates) {
    if (candidate.candidateId === chosen.candidateId) {
      next = replaceCandidate(
        next,
        candidate.candidateId,
        "APPROVED",
        now,
        reason || `user selected candidate ${choice}`,
      );
    } else {
      next = replaceCandidate(
        next,
        candidate.candidateId,
        "REJECTED",
        now,
        reason || "not selected",
      );
    }
  }
  next = pushEvent(next, {
    at: now,
    kind: "CANDIDATE_SELECTED",
    requestId: requestIdOf(state.request),
    candidateIds: [chosen.candidateId],
    detail: `selected slot ${choice} of round ${round}`,
  });
  return {
    ...next,
    openRound: null,
    selectedCandidateId: chosen.candidateId,
    selectedRound: round,
  };
}

/**
 * Convenience: create AND present the round in one step. This is the
 * entry point a caller uses per round (initial request and Try Again alike).
 * Returns the three REVIEW-state candidates for the round.
 */
export function generateCandidates(
  state: CandidateFlowState,
  now: string,
): { state: CandidateFlowState; candidates: readonly CharacterCandidate[] } {
  const priorRounds = state.candidates.map((c) => c.round);
  const round = priorRounds.length === 0 ? 1 : Math.max(...priorRounds) + 1;
  const withRound = createRound(state, round, now);
  const presented = presentRound(withRound, round, now);
  const candidates = presented.candidates.filter((c) => c.round === round);
  if (candidates.length !== CANDIDATES_PER_ROUND) {
    throw new CandidateFlowError(
      `round ${round} produced ${candidates.length} candidates, expected ${CANDIDATES_PER_ROUND}`,
    );
  }
  if (!candidates.every((c) => c.state === "REVIEW")) {
    throw new CandidateFlowError(
      `round ${round} candidates did not reach REVIEW state`,
    );
  }
  return { state: presented, candidates };
}

/**
 * The three candidates currently offered for selection. Only REVIEW-state
 * candidates of the open round are returned; rejected history is never
 * surfaced.
 */
export function selectableCandidates(
  state: CandidateFlowState,
): readonly CharacterCandidate[] {
  if (state.openRound === null) {
    return [];
  }
  return state.candidates.filter(
    (c) => c.round === state.openRound && isSelectable(c.state),
  );
}

/**
 * Hard gate: a candidate is selectable only if it is in the open round AND in
 * REVIEW state. Rejected candidates from ANY round fail this check.
 */
export function isCandidateSelectable(
  state: CandidateFlowState,
  candidateId: string,
): boolean {
  if (state.openRound === null) {
    return false;
  }
  const candidate = state.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    return false;
  }
  return candidate.round === state.openRound && isSelectable(candidate.state);
}