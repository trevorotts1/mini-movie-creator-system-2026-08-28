/**
 * Candidate record + request types for the 3-candidate flow (spec §9).
 *
 * A candidate is one proposed character design. New-character requests produce
 * exactly CANDIDATES_PER_ROUND candidates presented as Character 1/2/3. Every
 * candidate carries its own state-machine state, round number, and stable IDs
 * (permanent character-ID style, never display-name-keyed).
 */

import { CandidateStateError, isSelectable, type AssetState } from "./candidate-state.js";

export const CANDIDATES_PER_ROUND = 3;

/** How a candidate was produced — design variants in one generation round. */
export const CANDIDATE_DESIGN_KINDS = [
  "DESIGN_A",
  "DESIGN_B",
  "DESIGN_C",
] as const;

export type CandidateDesignKind = (typeof CANDIDATE_DESIGN_KINDS)[number];

/** Selection choices offered at the new-character gate (spec §3 gate 3). */
export const SELECTION_CHOICES = ["1", "2", "3", "TRY_AGAIN"] as const;

export type SelectionChoice = (typeof SELECTION_CHOICES)[number];

/**
 * The pending new-character request raised by the script gate. `characterId`
 * is the stable business ID (CHAR_..._001 style) the candidates compete for;
 * it is proposed, not locked — locking is CHAR-005.
 */
export interface CharacterCandidateRequest {
  readonly characterId: string;
  readonly displayName: string;
  readonly seriesId: string;
  readonly episodeId: string;
  /** Short creative brief the designs must satisfy (untrusted text: data only). */
  readonly brief: string;
  readonly requestedAt: string;
}

/** One proposed design for the requested character. */
export interface CharacterCandidate {
  readonly candidateId: string;
  readonly characterId: string;
  readonly requestId: string;
  readonly round: number;
  readonly design: CandidateDesignKind;
  /** 1-based presentation slot — Character 1 / 2 / 3 in the gate UX. */
  readonly slot: 1 | 2 | 3;
  readonly displayName: string;
  readonly state: AssetState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Human/agent reason recorded whenever a state was last changed. */
  readonly lastTransitionReason: string | null;
}

/**
 * Validate the shape of a new-character request. Throws on missing/blank
 * required fields. Brief text is treated as untrusted data: stored verbatim,
 * never interpreted or executed.
 */
export function assertValidRequest(
  request: CharacterCandidateRequest,
): CharacterCandidateRequest {
  const blank = (value: string): boolean => value.trim().length === 0;
  if (blank(request.characterId)) {
    throw new Error("CharacterCandidateRequest.characterId must be non-blank");
  }
  if (blank(request.displayName)) {
    throw new Error("CharacterCandidateRequest.displayName must be non-blank");
  }
  if (blank(request.seriesId)) {
    throw new Error("CharacterCandidateRequest.seriesId must be non-blank");
  }
  if (blank(request.episodeId)) {
    throw new Error("CharacterCandidateRequest.episodeId must be non-blank");
  }
  if (blank(request.brief)) {
    throw new Error("CharacterCandidateRequest.brief must be non-blank");
  }
  if (Number.isNaN(Date.parse(request.requestedAt))) {
    throw new Error("CharacterCandidateRequest.requestedAt must be an ISO timestamp");
  }
  return request;
}

/** Deterministic candidate ID: <characterId>#r<round>d<slot>. */
export function makeCandidateId(
  characterId: string,
  round: number,
  slot: number,
): string {
  return `${characterId}#r${round}d${slot}`;
}

/** Stable grouping key for candidates of one request. */
export function requestIdOf(request: CharacterCandidateRequest): string {
  return `${request.seriesId}/${request.episodeId}/${request.characterId}`;
}

/**
 * Build the three candidates for one round of a request. States start at
 * DRAFT; the flow moves the whole round to REVIEW when presented.
 */
export function createCandidatesForRound(
  request: CharacterCandidateRequest,
  round: number,
  now: string,
): CharacterCandidate[] {
  assertValidRequest(request);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`round must be a positive integer, got ${round}`);
  }
  if (Number.isNaN(Date.parse(now))) {
    throw new Error("now must be an ISO timestamp");
  }
  return CANDIDATE_DESIGN_KINDS.map((design, index) => ({
    candidateId: makeCandidateId(request.characterId, round, index + 1),
    characterId: request.characterId,
    requestId: requestIdOf(request),
    round,
    design,
    slot: (index + 1) as 1 | 2 | 3,
    displayName: request.displayName,
    state: "DRAFT" as const,
    createdAt: now,
    updatedAt: now,
    lastTransitionReason: null,
  }));
}

/** Guard used when a candidate is about to be selected. */
export function requireSelectable(candidate: CharacterCandidate): CharacterCandidate {
  if (!isSelectable(candidate.state)) {
    throw new CandidateStateError(
      candidate.state,
      candidate.state,
      `candidate ${candidate.candidateId} is not selectable (state ${candidate.state})`,
    );
  }
  return candidate;
}