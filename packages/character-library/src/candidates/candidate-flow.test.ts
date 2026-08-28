import { describe, expect, it } from "vitest";

import {
  CANDIDATES_PER_ROUND,
  CandidateFlowError,
  applySelection,
  createCandidatesForRound,
  createRound,
  generateCandidates,
  isCandidateSelectable,
  makeCandidateId,
  presentRound,
  requireSelectable,
  selectableCandidates,
  startCandidateFlow,
  type CharacterCandidateRequest,
} from "./index.js";
import { CandidateStateError } from "./index.js";

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T12:05:00.000Z";

function request(overrides: Partial<CharacterCandidateRequest> = {}): CharacterCandidateRequest {
  return {
    characterId: "CHAR_MONICA_BENNETT_001",
    displayName: "Monica Bennett",
    seriesId: "SERIES_TEST",
    episodeId: "S01E01",
    brief: "Lead detective, 40s, composed, city-noir wardrobe.",
    requestedAt: NOW,
    ...overrides,
  };
}

function startedFlow() {
  return startCandidateFlow(request(), NOW);
}

function firstRound() {
  const { state, candidates } = generateCandidates(startedFlow(), NOW);
  return { state, candidates };
}

describe("candidate generation", () => {
  it("a new character request produces exactly 3 candidates", () => {
    const { candidates } = firstRound();
    expect(CANDIDATES_PER_ROUND).toBe(3);
    expect(candidates).toHaveLength(3);
  });

  it("new candidates start as DRAFT then present as REVIEW", () => {
    const created = createCandidatesForRound(request(), 1, NOW);
    expect(created.every((c) => c.state === "DRAFT")).toBe(true);
    const state = presentRound(createRound(startedFlow(), 1, NOW), 1, LATER);
    const round1 = state.candidates.filter((c) => c.round === 1);
    expect(round1.every((c) => c.state === "REVIEW")).toBe(true);
  });

  it("candidates get slots 1/2/3 with distinct design kinds and IDs", () => {
    const { candidates } = firstRound();
    expect(candidates.map((c) => c.slot)).toEqual([1, 2, 3]);
    expect(new Set(candidates.map((c) => c.design)).size).toBe(3);
    expect(new Set(candidates.map((c) => c.candidateId)).size).toBe(3);
    expect(candidates[0]?.candidateId).toBe(
      makeCandidateId("CHAR_MONICA_BENNETT_001", 1, 1),
    );
  });

  it("generateCandidates refuses to run while a round is open", () => {
    const { state } = firstRound();
    expect(() => generateCandidates(state, LATER)).toThrow(CandidateFlowError);
  });

  it("request validation rejects blank fields and bad timestamps", () => {
    expect(() => createCandidatesForRound(request({ characterId: "  " }), 1, NOW)).toThrow();
    expect(() => createCandidatesForRound(request({ displayName: "" }), 1, NOW)).toThrow();
    expect(() => createCandidatesForRound(request({ brief: " " }), 1, NOW)).toThrow();
    expect(() => createCandidatesForRound(request({ requestedAt: "not-a-date" }), 1, NOW)).toThrow();
    expect(() => createCandidatesForRound(request(), 0, NOW)).toThrow();
  });
});

describe("selection", () => {
  it("selecting slot 2 approves it and rejects its siblings", () => {
    let { state } = firstRound();
    state = applySelection(state, "2", LATER);
    const round1 = state.candidates.filter((c) => c.round === 1);
    const bySlot = (slot: number) => round1.find((c) => c.slot === slot);
    expect(bySlot(2)?.state).toBe("APPROVED");
    expect(bySlot(1)?.state).toBe("REJECTED");
    expect(bySlot(3)?.state).toBe("REJECTED");
    expect(state.selectedCandidateId).toBe(bySlot(2)?.candidateId ?? null);
    expect(state.selectedRound).toBe(1);
    expect(state.openRound).toBe(null);
  });

  it("only REVIEW candidates can be selected — DRAFT throws", () => {
    const state = createRound(startedFlow(), 1, NOW);
    const draft = state.candidates.find((c) => c.round === 1 && c.slot === 1);
    expect(draft?.state).toBe("DRAFT");
    expect(() => requireSelectable(draft!)).toThrow(CandidateStateError);
    // And the flow-level gate refuses the selection of a never-presented round.
    expect(() => applySelection(state, "1", LATER)).toThrow(CandidateStateError);
  });
});

describe("Try Again", () => {
  it("rejects the open round terminally and opens no round", () => {
    let { state } = firstRound();
    state = applySelection(state, "TRY_AGAIN", LATER);
    const round1 = state.candidates.filter((c) => c.round === 1);
    expect(round1).toHaveLength(3);
    expect(round1.every((c) => c.state === "REJECTED")).toBe(true);
    expect(state.openRound).toBe(null);
    expect(state.selectedCandidateId).toBe(null);
    expect(selectableCandidates(state)).toHaveLength(0);
  });

  it("Try Again creates 3 NEW candidates in a new round", () => {
    let { state } = firstRound();
    state = applySelection(state, "TRY_AGAIN", LATER);
    const second = generateCandidates(state, LATER);
    state = second.state;
    const round2 = state.candidates.filter((c) => c.round === 2);
    expect(round2).toHaveLength(3);
    expect(round2.every((c) => c.state === "REVIEW")).toBe(true);
    // New IDs, distinct from round 1.
    const round1Ids = new Set(state.candidates.filter((c) => c.round === 1).map((c) => c.candidateId));
    for (const candidate of round2) {
      expect(round1Ids.has(candidate.candidateId)).toBe(false);
    }
    expect(selectableCandidates(state)).toHaveLength(3);
    expect(selectableCandidates(state).every((c) => c.round === 2)).toBe(true);
  });

  it("rejected candidates from earlier rounds are never selectable (state-machine gate)", () => {
    let { state } = firstRound();
    state = applySelection(state, "TRY_AGAIN", LATER);
    const round1 = state.candidates.filter((c) => c.round === 1);
    const second = generateCandidates(state, LATER);
    state = second.state;

    // Every round-1 candidate is REJECTED and fails the selectable gate.
    for (const candidate of round1) {
      expect(candidate.state).toBe("REJECTED");
      expect(isCandidateSelectable(state, candidate.candidateId)).toBe(false);
      expect(() => requireSelectable(candidate)).toThrow(CandidateStateError);
    }
    // Even after round 2 resolves, history stays rejected.
    state = applySelection(state, "3", LATER);
    for (const candidate of round1) {
      expect(isCandidateSelectable(state, candidate.candidateId)).toBe(false);
    }
    expect(isCandidateSelectable(state, "does-not-exist")).toBe(false);
  });

  it("a rejected candidate cannot be revived into any state", () => {
    let { state } = firstRound();
    const rejectedId = state.candidates[0]!.candidateId;
    state = applySelection(state, "TRY_AGAIN", LATER);
    const rejected = state.candidates.find((c) => c.candidateId === rejectedId)!;
    expect(rejected.state).toBe("REJECTED");
    // The machine has no outgoing edge from REJECTED, so any revive attempt
    // throws — including the sibling-selection path.
    expect(() => applySelection(state, "1", LATER)).toThrow(CandidateFlowError);
  });

  it("two Try Again rounds chain: round 3 exists only after round 2 is rejected", () => {
    let { state } = firstRound();
    state = applySelection(state, "TRY_AGAIN", LATER);
    state = generateCandidates(state, LATER).state;
    expect(state.openRound).toBe(2);
    state = applySelection(state, "TRY_AGAIN", LATER);
    state = generateCandidates(state, LATER).state;
    expect(state.openRound).toBe(3);
    expect(state.candidates.filter((c) => c.round === 3)).toHaveLength(3);
    // Rounds 1 and 2 all rejected, round 3 in REVIEW.
    expect(state.candidates.filter((c) => c.round < 3).every((c) => c.state === "REJECTED")).toBe(true);
    expect(state.candidates.filter((c) => c.round === 3).every((c) => c.state === "REVIEW")).toBe(true);
  });
});

describe("flow integrity", () => {
  it("keeps an audit event trail for the whole flow", () => {
    let { state } = firstRound();
    state = applySelection(state, "TRY_AGAIN", LATER);
    state = generateCandidates(state, LATER).state;
    state = applySelection(state, "2", LATER);
    const kinds = state.events.map((e) => e.kind);
    expect(kinds).toContain("REQUEST_CREATED");
    expect(kinds).toContain("ROUND_CREATED");
    expect(kinds).toContain("ROUND_PRESENTED");
    expect(kinds).toContain("TRY_AGAIN");
    expect(kinds).toContain("CANDIDATE_SELECTED");
  });

  it("cannot create a round after the request is resolved", () => {
    let { state } = firstRound();
    state = applySelection(state, "1", LATER);
    expect(() => createRound(state, 2, LATER)).toThrow(CandidateFlowError);
  });
});