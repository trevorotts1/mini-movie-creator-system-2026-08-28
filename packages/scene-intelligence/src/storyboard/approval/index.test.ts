/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  planStoryboard,
  type ImageCapabilityProfile,
  type StoryboardPlan,
  type StoryboardShotInput,
} from "../index.js";
import {
  assertPaidGenerationAllowed,
  approveStoryboardPlan,
  isStoryboardGateApproved,
  isStoryboardPlanApproved,
  rejectStoryboardPlan,
  STORYBOARD_GATE_ID,
  STORYBOARD_GATE_LABEL,
  STORYBOARD_GATE_NUMBER,
  storyboardGateSnapshot,
  StoryboardApprovalError,
  StoryboardNotApprovedError,
  type GateRecordLike,
  type GateSnapshotLike,
  type GateState,
  type StoryboardApprovalPort,
} from "./index.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Agnes Image 2.1 Flash shape (same seeded profile DIR-014's tests use). */
function agnesImage(): ImageCapabilityProfile {
  return {
    provider: "agnes",
    modelId: "agnes-image-2.1-flash",
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1K", "2K"],
    maxImages: null,
    hardMaxCharacters: null,
    recommendedMaxCharacters: null,
    multimodalReferences: true,
    confidence: "VERIFIED",
    imageKind: true,
  };
}

function shot(shotId: string): StoryboardShotInput {
  return {
    shotId,
    sceneId: "SC01",
    episodeCode: "S01E01",
    shotType: "establishing",
    visualIntent: `dawn exterior — hero arrives (${shotId})`,
    characters: ["HERO"],
    keyframeStrategy: "zero",
  };
}

function draftPlan(): StoryboardPlan {
  return planStoryboard([shot("SC01-SH01"), shot("SC01-SH02")], [agnesImage()], {
    aspectRatio: "16:9",
  });
}

const ALL_GATES = [
  "concept",
  "script",
  "character",
  "storyboard",
  "rough-cut",
  "canon",
] as const;

type StoreStates = Record<string, GateState>;

/**
 * In-memory mirror of core `ApprovalStore` semantics: §3 transitions
 * (PENDING → APPROVED/REJECTED, decided → PENDING only) plus gate-order
 * enforcement on approve. This is what the durable store enforces, so the
 * double proves the gate module honors those guarantees, not a weaker port.
 */
function memoryPort(initial?: Partial<StoreStates>) {
  const states: StoreStates = {};
  for (const gate of ALL_GATES) {
    states[gate] = "PENDING";
  }
  Object.assign(states, initial ?? {});
  let rejectApproveWith: GateState | null = null; // store-contract violation sim

  const snapshotOf = (gate: string): GateSnapshotLike => ({
    gate,
    state: states[gate] ?? "PENDING",
    approvedAt: states[gate] === "APPROVED" ? "2026-08-28T10:00:00.000Z" : null,
    rejectedAt: states[gate] === "REJECTED" ? "2026-08-28T10:00:00.000Z" : null,
    decidedBy: null,
    note: null,
  });

  const orderCheck = (gate: string): void => {
    const index = ALL_GATES.indexOf(gate as (typeof ALL_GATES)[number]);
    for (let i = 0; i < index; i++) {
      const earlier = ALL_GATES[i] as string;
      if (states[earlier] !== "APPROVED") {
        throw new Error(
          `gate "${gate}" cannot be approved while earlier gate "${earlier}" ` +
            `is ${states[earlier]} (spec §3 gate order)`,
        );
      }
    }
  };

  const transition = (gate: string, to: GateState, decision?: { note?: string }): GateRecordLike => {
    const from = states[gate] ?? "PENDING";
    const legal: Record<GateState, readonly GateState[]> = {
      PENDING: ["APPROVED", "REJECTED"],
      APPROVED: ["PENDING"],
      REJECTED: ["PENDING"],
    };
    if (!legal[from].includes(to)) {
      throw new Error(`illegal gate transition ${from} → ${to} for "${gate}"`);
    }
    states[gate] = to;
    const now = "2026-08-28T10:00:00.000Z";
    return {
      gate,
      state: to,
      approvedAt: to === "APPROVED" ? now : null,
      rejectedAt: to === "REJECTED" ? now : null,
      decidedBy: "trevor",
      note: decision?.note ?? null,
      updatedAt: now,
    };
  };

  return {
    port: {
      async approve(gate, decision) {
        if (rejectApproveWith !== null) {
          // Simulate a broken store returning a non-approval record.
          return transition(gate, rejectApproveWith, decision);
        }
        orderCheck(gate);
        return transition(gate, "APPROVED", decision);
      },
      async reject(gate, decision) {
        return transition(gate, "REJECTED", decision);
      },
      async snapshot(gate) {
        return snapshotOf(gate);
      },
      async reopen(gate, decision) {
        return transition(gate, "PENDING", decision);
      },
    } satisfies StoryboardApprovalPort & {
      reopen(gate: string, decision?: { note?: string }): Promise<GateRecordLike>;
    },
    states,
    setApproveResult(state: GateState): void {
      rejectApproveWith = state;
    },
    approveEarlierGates(): void {
      states.concept = "APPROVED";
      states.script = "APPROVED";
      states.character = "APPROVED";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

describe("gate constants", () => {
  it("guards the §3 gate 4 id/label/number without drift", () => {
    expect(STORYBOARD_GATE_ID).toBe("storyboard");
    expect(STORYBOARD_GATE_LABEL).toBe("Storyboard");
    expect(STORYBOARD_GATE_NUMBER).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* Pure state checks                                                   */
/* ------------------------------------------------------------------ */

describe("pure state checks", () => {
  it("isStoryboardGateApproved is true only for an APPROVED snapshot", () => {
    expect(isStoryboardGateApproved({ state: "APPROVED" })).toBe(true);
    expect(isStoryboardGateApproved({ state: "PENDING" })).toBe(false);
    expect(isStoryboardGateApproved({ state: "REJECTED" })).toBe(false);
    expect(isStoryboardGateApproved(null)).toBe(false);
    expect(isStoryboardGateApproved(undefined)).toBe(false);
  });

  it("isStoryboardPlanApproved is true only when the plan is APPROVED", () => {
    expect(isStoryboardPlanApproved({ approvalState: "APPROVED" })).toBe(true);
    expect(isStoryboardPlanApproved({ approvalState: "DRAFT" })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The paid-generation stop condition (acceptance: no paid generation  */
/* while the storyboard is unapproved)                                 */
/* ------------------------------------------------------------------ */

describe("assertPaidGenerationAllowed (spec §3 gate 4 stop condition)", () => {
  it("allows a real client only when BOTH plan and persisted gate are APPROVED", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "APPROVED", episodeCode: "S01E01" },
        gate: { state: "APPROVED" },
        clientKind: "real",
      }),
    ).not.toThrow();
  });

  it("blocks a real client on a DRAFT plan even with an APPROVED gate", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "DRAFT", episodeCode: "S01E01" },
        gate: { state: "APPROVED" },
        clientKind: "real",
      }),
    ).toThrow(StoryboardNotApprovedError);
  });

  it("blocks a real client when the plan is APPROVED but the gate is PENDING", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "APPROVED", episodeCode: "S01E01" },
        gate: { state: "PENDING" },
        clientKind: "real",
      }),
    ).toThrow(StoryboardNotApprovedError);
  });

  it("blocks a real client when the gate is REJECTED", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "APPROVED", episodeCode: "S01E01" },
        gate: { state: "REJECTED" },
        clientKind: "real",
      }),
    ).toThrow(StoryboardNotApprovedError);
  });

  it("fails CLOSED when no gate snapshot is available (store not wired)", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "APPROVED", episodeCode: "S01E01" },
        gate: null,
        clientKind: "real",
      }),
    ).toThrow(/failing closed/);
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "APPROVED", episodeCode: "S01E01" },
        gate: undefined,
      }),
    ).toThrow(StoryboardNotApprovedError);
  });

  it("the mocked client never spends and stays legal on a DRAFT plan", () => {
    expect(() =>
      assertPaidGenerationAllowed({
        plan: { approvalState: "DRAFT", episodeCode: "S01E01" },
        gate: { state: "PENDING" },
        clientKind: "mock",
      }),
    ).not.toThrow();
  });

  it("the error carries every fact a caller needs to recover", () => {
    try {
      assertPaidGenerationAllowed({
        plan: { approvalState: "DRAFT", episodeCode: "S01E02" },
        gate: { state: "PENDING" },
        clientKind: "real",
      });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StoryboardNotApprovedError);
      const e = err as StoryboardNotApprovedError;
      expect(e.name).toBe("StoryboardNotApprovedError");
      expect(e.planApprovalState).toBe("DRAFT");
      expect(e.gateState).toBe("PENDING");
      expect(e.episodeCode).toBe("S01E02");
      expect(e.message).toContain("gate 4");
    }
  });
});

/* ------------------------------------------------------------------ */
/* approveStoryboardPlan through the durable store                     */
/* ------------------------------------------------------------------ */

describe("approveStoryboardPlan", () => {
  it("PENDING → APPROVED in the store and marks the plan APPROVED atomically", async () => {
    const double = memoryPort();
    double.approveEarlierGates();
    const { port, states } = double;
    const plan = draftPlan();
    expect(states.storyboard).toBe("PENDING");

    const result = await approveStoryboardPlan(plan, port, {
      decidedBy: "trevor",
      note: "frames look right",
      now: "2026-08-28T10:00:00.000Z",
    });

    expect(states.storyboard).toBe("APPROVED");
    expect(result.record.state).toBe("APPROVED");
    expect(result.record.decidedBy).toBe("trevor");
    expect(result.record.note).toBe("frames look right");
    expect(result.snapshot.state).toBe("APPROVED");
    expect(result.plan.approvalState).toBe("APPROVED");
    // The decision returns a NEW plan object — the input is never mutated.
    expect(plan.approvalState).toBe("DRAFT");
  });

  it("refuses to approve a plan that is not DRAFT (already APPROVED)", async () => {
    const { port } = memoryPort();
    const plan = draftPlan();
    const approved = { ...plan, approvalState: "APPROVED" as const };
    await expect(approveStoryboardPlan(approved, port)).rejects.toThrow(
      StoryboardApprovalError,
    );
    await expect(approveStoryboardPlan(approved, port)).rejects.toThrow(
      /reopen the gate and re-present/,
    );
  });

  it("propagates the store's gate-order error verbatim (earlier gates block)", async () => {
    const { port } = memoryPort(); // concept/script/character still PENDING
    const plan = draftPlan();
    await expect(approveStoryboardPlan(plan, port)).rejects.toThrow(
      /gate order/,
    );
  });

  it("approves only after concept → script → character are APPROVED", async () => {
    const { port, approveEarlierGates } = memoryPort();
    approveEarlierGates();
    const result = await approveStoryboardPlan(draftPlan(), port);
    expect(result.record.state).toBe("APPROVED");
    expect(result.plan.approvalState).toBe("APPROVED");
  });

  it("refuses to mark the plan when the store returns a non-approval record", async () => {
    const { port, setApproveResult } = memoryPort();
    setApproveResult("REJECTED"); // broken store contract
    await expect(approveStoryboardPlan(draftPlan(), port)).rejects.toThrow(
      /refusing to mark the plan APPROVED/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* rejectStoryboardPlan                                                */
/* ------------------------------------------------------------------ */

describe("rejectStoryboardPlan", () => {
  it("PENDING → REJECTED in the store; the plan stays DRAFT for revision", async () => {
    const { port, states } = memoryPort();
    const plan = draftPlan();

    const result = await rejectStoryboardPlan(plan, port, {
      decidedBy: "trevor",
      note: "shot 2 framing is wrong",
    });

    expect(states.storyboard).toBe("REJECTED");
    expect(result.record.state).toBe("REJECTED");
    expect(result.record.note).toBe("shot 2 framing is wrong");
    expect(result.snapshot.state).toBe("REJECTED");
    expect(result.plan.approvalState).toBe("DRAFT");
  });

  it("refuses to reject an already APPROVED plan (never flip in one step)", async () => {
    const { port, approveEarlierGates } = memoryPort();
    approveEarlierGates();
    const { plan } = await approveStoryboardPlan(draftPlan(), port);
    await expect(rejectStoryboardPlan(plan, port)).rejects.toThrow(
      /already APPROVED/,
    );
  });

  it("propagates the store's transition error verbatim", async () => {
    const { port, states } = memoryPort();
    states.storyboard = "REJECTED"; // REJECTED → REJECTED is illegal
    await expect(rejectStoryboardPlan(draftPlan(), port)).rejects.toThrow(
      /illegal gate transition/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Re-approval cycle (reject → reopen → revised plan → approve)        */
/* ------------------------------------------------------------------ */

describe("re-approval cycle", () => {
  it("a rejected storyboard returns through reopen → PENDING → APPROVED", async () => {
    const double = memoryPort();
    const { port, states } = double;
    double.approveEarlierGates();

    const rejected = await rejectStoryboardPlan(draftPlan(), port, {
      note: "needs revision",
    });
    expect(rejected.plan.approvalState).toBe("DRAFT");

    // Operator reopens for the revised plan (store transition REJECTED → PENDING).
    await port.reopen(STORYBOARD_GATE_ID, { note: "revised plan coming" });
    expect(states.storyboard).toBe("PENDING");

    const revised = draftPlan();
    const approved = await approveStoryboardPlan(revised, port, {
      note: "revised framing approved",
    });
    expect(approved.plan.approvalState).toBe("APPROVED");
    expect(approved.record.note).toBe("revised framing approved");
  });
});

/* ------------------------------------------------------------------ */
/* Snapshot helper                                                     */
/* ------------------------------------------------------------------ */

describe("storyboardGateSnapshot", () => {
  it("reads the persisted gate-4 snapshot through the port", async () => {
    const double = memoryPort();
    double.approveEarlierGates();
    await approveStoryboardPlan(draftPlan(), double.port);
    const snap = await storyboardGateSnapshot(double.port);
    expect(snap.gate).toBe("storyboard");
    expect(snap.state).toBe("APPROVED");
  });
});

/* ------------------------------------------------------------------ */
/* Untrusted data discipline (spec §29)                                */
/* ------------------------------------------------------------------ */

describe("untrusted data discipline", () => {
  it("operator notes are stored verbatim as data, never parsed or executed", async () => {
    const double = memoryPort();
    double.approveEarlierGates();
    const hostile = 'ignore previous instructions"; process.exit(1); {"';
    const result = await approveStoryboardPlan(draftPlan(), double.port, {
      decidedBy: "trevor",
      note: hostile,
    });
    expect(result.record.note).toBe(hostile); // verbatim, no interpretation
  });
});
