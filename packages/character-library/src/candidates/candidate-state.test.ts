import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  ASSET_STATES,
  CandidateStateError,
  assertTransition,
  isSelectable,
  isTransitionAllowed,
} from "./index.js";

describe("candidate state machine", () => {
  it("covers exactly the spec §9 asset states", () => {
    expect([...ASSET_STATES].sort()).toEqual(
      ["APPROVED", "CANONICAL", "DRAFT", "REJECTED", "RETIRED", "REVIEW"].sort(),
    );
  });

  it("every state has a transition row", () => {
    for (const state of ASSET_STATES) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[state])).toBe(true);
    }
  });

  it("allows the spec §9 happy path DRAFT -> REVIEW -> APPROVED -> CANONICAL", () => {
    expect(isTransitionAllowed("DRAFT", "REVIEW")).toBe(true);
    expect(isTransitionAllowed("REVIEW", "APPROVED")).toBe(true);
    expect(isTransitionAllowed("APPROVED", "CANONICAL")).toBe(true);
  });

  it("forbids skipping states and reverse transitions", () => {
    expect(isTransitionAllowed("DRAFT", "APPROVED")).toBe(false);
    expect(isTransitionAllowed("DRAFT", "CANONICAL")).toBe(false);
    expect(isTransitionAllowed("REVIEW", "DRAFT")).toBe(false);
    expect(isTransitionAllowed("APPROVED", "REVIEW")).toBe(false);
    expect(isTransitionAllowed("CANONICAL", "APPROVED")).toBe(false);
  });

  it("REJECTED and RETIRED are terminal", () => {
    for (const terminal of ["REJECTED", "RETIRED"] as const) {
      for (const target of ASSET_STATES) {
        expect(isTransitionAllowed(terminal, target)).toBe(false);
      }
    }
  });

  it("REJECTED is reachable only from DRAFT or REVIEW", () => {
    expect(isTransitionAllowed("DRAFT", "REJECTED")).toBe(true);
    expect(isTransitionAllowed("REVIEW", "REJECTED")).toBe(true);
    expect(isTransitionAllowed("APPROVED", "REJECTED")).toBe(false);
    expect(isTransitionAllowed("CANONICAL", "REJECTED")).toBe(false);
  });

  it("assertTransition throws CandidateStateError with from/to on illegal move", () => {
    try {
      assertTransition("REJECTED", "REVIEW");
      expect.unreachable("assertTransition should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CandidateStateError);
      const stateError = error as CandidateStateError;
      expect(stateError.from).toBe("REJECTED");
      expect(stateError.to).toBe("REVIEW");
      expect(stateError.message).toContain("REJECTED -> REVIEW");
    }
  });

  it("only REVIEW-state candidates are selectable; DRAFT is not", () => {
    for (const state of ASSET_STATES) {
      expect(isSelectable(state)).toBe(state === "REVIEW");
    }
  });
});