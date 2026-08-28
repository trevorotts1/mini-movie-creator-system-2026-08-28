import { describe, expect, it } from "vitest";
import {
  GATE_IDS,
  GATE_STATES,
  GateOrderError,
  GateTransitionError,
  LEGAL_GATE_TRANSITIONS,
  assertGateOrder,
  isLegalGateTransition,
  requireGateTransition,
} from "../index.js";
import type { GateId, GateState } from "../index.js";

const ALL: readonly GateState[] = GATE_STATES;
const GATES: readonly GateId[] = GATE_IDS;

function allApprovals(
  state: GateState,
): Record<GateId, GateState> {
  const map = {} as Record<GateId, GateState>;
  for (const g of GATES) map[g] = state;
  return map;
}

describe("spec §3 gate state machine — legal transitions", () => {
  it("allows PENDING -> APPROVED (explicit operator sign-off)", () => {
    expect(isLegalGateTransition("PENDING", "APPROVED")).toBe(true);
  });

  it("allows PENDING -> REJECTED (send back for revision)", () => {
    expect(isLegalGateTransition("PENDING", "REJECTED")).toBe(true);
  });

  it("allows decided -> PENDING (reopen for revised work)", () => {
    expect(isLegalGateTransition("APPROVED", "PENDING")).toBe(true);
    expect(isLegalGateTransition("REJECTED", "PENDING")).toBe(true);
  });

  it("forbids APPROVED -> REJECTED (never flip a decision in one step)", () => {
    expect(isLegalGateTransition("APPROVED", "REJECTED")).toBe(false);
  });

  it("forbids REJECTED -> APPROVED (rejected work re-enters through PENDING)", () => {
    expect(isLegalGateTransition("REJECTED", "APPROVED")).toBe(false);
  });

  it("forbids same-state self-transitions", () => {
    for (const s of ALL) {
      expect(isLegalGateTransition(s, s)).toBe(false);
    }
  });

  it("the transition table covers exactly the three persisted states", () => {
    expect(Object.keys(LEGAL_GATE_TRANSITIONS).sort()).toEqual(
      [...GATE_STATES].sort(),
    );
    for (const [from, targets] of Object.entries(LEGAL_GATE_TRANSITIONS)) {
      for (const to of targets) {
        // every listed target is itself a real state
        expect(ALL).toContain(to as GateState);
        void from;
      }
    }
  });

  it("requireGateTransition returns the target on legal moves", () => {
    expect(requireGateTransition("PENDING", "APPROVED", "concept")).toBe("APPROVED");
    expect(requireGateTransition("PENDING", "REJECTED", "script")).toBe("REJECTED");
    expect(requireGateTransition("APPROVED", "PENDING", "canon")).toBe("PENDING");
  });
});

describe("spec §3 gate state machine — illegal transitions throw", () => {
  it("throws GateTransitionError on every illegal move, naming the gate", () => {
    const illegal: Array<[GateState, GateState]> = [
      ["APPROVED", "REJECTED"],
      ["REJECTED", "APPROVED"],
      ["PENDING", "PENDING"],
      ["APPROVED", "APPROVED"],
      ["REJECTED", "REJECTED"],
    ];
    for (const [from, to] of illegal) {
      for (const gate of GATES) {
        expect(() => requireGateTransition(from, to, gate)).toThrow(
          GateTransitionError,
        );
      }
    }
  });

  it("carries from/to/gate on the error", () => {
    try {
      requireGateTransition("APPROVED", "REJECTED", "rough-cut");
      expect.unreachable("must throw");
    } catch (err) {
      const e = err as GateTransitionError;
      expect(e.name).toBe("GateTransitionError");
      expect(e.from).toBe("APPROVED");
      expect(e.to).toBe("REJECTED");
      expect(e.gate).toBe("rough-cut");
      expect(e.message).toContain("rough-cut");
    }
  });

  it("throws on an unknown state entering the machine", () => {
    expect(() => requireGateTransition("OPEN" as GateState, "APPROVED")).toThrow(
      GateTransitionError,
    );
    expect(() => requireGateTransition("PENDING", "CLOSED" as GateState)).toThrow(
      GateTransitionError,
    );
  });
});

describe("spec §3 gate order", () => {
  it("approving gate 1 with no earlier gates passes", () => {
    expect(() =>
      assertGateOrder("concept", allApprovals("PENDING")),
    ).not.toThrow();
  });

  it("blocks approval while any earlier gate is PENDING", () => {
    for (let i = 1; i < GATES.length; i += 1) {
      const approvals = allApprovals("PENDING");
      expect(() =>
        assertGateOrder(GATES[i] as GateId, approvals),
      ).toThrow(GateOrderError);
    }
  });

  it("blocks approval while any earlier gate is REJECTED", () => {
    const approvals = allApprovals("APPROVED");
    approvals.concept = "REJECTED";
    expect(() => assertGateOrder("script", approvals)).toThrow(GateOrderError);
    approvals.concept = "APPROVED";
    approvals.character = "REJECTED";
    expect(() => assertGateOrder("storyboard", approvals)).toThrow(GateOrderError);
  });

  it("passes when every earlier gate is APPROVED", () => {
    const approvals = allApprovals("PENDING");
    approvals.concept = "APPROVED";
    approvals.script = "APPROVED";
    approvals.character = "APPROVED";
    approvals.storyboard = "APPROVED";
    expect(() => assertGateOrder("rough-cut", approvals)).not.toThrow();
  });

  it("names the blocking gate on the error", () => {
    try {
      assertGateOrder("storyboard", {
        ...allApprovals("APPROVED"),
        concept: "PENDING",
      });
      expect.unreachable("must throw");
    } catch (err) {
      const e = err as GateOrderError;
      expect(e.name).toBe("GateOrderError");
      expect(e.gate).toBe("storyboard");
      expect(e.blockingGate).toBe("concept");
      expect(e.blockingState).toBe("PENDING");
    }
  });

  it("the full §3 sequence approves cleanly in order and fails out of order", () => {
    const approvals = allApprovals("PENDING");
    for (const gate of GATES) {
      expect(() => assertGateOrder(gate, approvals)).not.toThrow();
      approvals[gate] = "APPROVED";
    }
    // reset concept after everything approved -> re-approving canon still fine,
    // but a fresh approval of a later gate while an earlier one was reopened throws
    approvals.script = "PENDING";
    expect(() => assertGateOrder("canon", approvals)).toThrow(GateOrderError);
  });
});