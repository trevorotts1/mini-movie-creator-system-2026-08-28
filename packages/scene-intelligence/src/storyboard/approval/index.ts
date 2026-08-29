/**
 * Storyboard approval gate — gate 4 of spec §3 ("Storyboard — storyboard/
 * keyframe plan approved; no paid generation before this") and runbook §25
 * step 15 ("storyboard, STOP for storyboard approval").
 *
 * DIR-015 owns this file (`packages/scene-intelligence/src/storyboard/
 * approval/` — one file per task in the approvals pattern, ownership.md).
 * DIR-014's storyboard contract (../index.ts) plans frames and always emits a
 * DRAFT plan; THIS module owns the only path that advances it:
 *
 *   - {@link approveStoryboardPlan}: PENDING → APPROVED through the durable
 *     approval store (gate order enforced there — concept → script →
 *     character → storyboard, spec §3), and the plan marked APPROVED in the
 *     same breath, so a plan can never be approved without its gate record;
 *   - {@link rejectStoryboardPlan}: PENDING → REJECTED, plan held at DRAFT
 *     for revision (re-approval presents the revised plan again);
 *   - {@link assertPaidGenerationAllowed}: the mechanical stop condition —
 *     throws {@link StoryboardNotApprovedError} unless BOTH the plan is
 *     APPROVED and the persisted gate is APPROVED. Every paid generation
 *     path (generation tasks, provider adapters) must call this before any
 *     real (kind: "real") image client runs; the mocked client stays legal
 *     on a DRAFT plan because it never spends.
 *
 * The gate store arrives as an injected port, declared structurally so this
 * module stays decoupled from `@mmcs/core` internals — the shape is
 * identical to `packages/core/src/approvals/` (`GateSnapshot`,
 * `GateRecord`, `ApprovalStore.approve/reject/snapshot`). Do not diverge:
 * VID-014's `ApprovalGatePort` and QC-011 human review read the same
 * document.
 *
 * Story/script text flowing through these types is UNTRUSTED DATA — stored
 * verbatim into record fields, never parsed, executed, or interpreted as
 * instructions (spec §29).
 */

import {
  StoryboardContractError,
  type StoryboardPlan,
} from "../index.js";

/* ------------------------------------------------------------------ */
/* Gate constants (mirror @mmcs/core approvals/gates.ts — do not drift) */
/* ------------------------------------------------------------------ */

/** The stable §3 gate id this module guards. */
export const STORYBOARD_GATE_ID = "storyboard" as const;

/** The §3 gate label, verbatim, for CLI/log output. */
export const STORYBOARD_GATE_LABEL = "Storyboard" as const;

/** Gate 4's 1-based position in the §3 mandatory order. */
export const STORYBOARD_GATE_NUMBER = 4 as const;

/** Approval states a gate can be in (persisted domain state, spec §3). */
export type GateState = "PENDING" | "APPROVED" | "REJECTED";

/** Read-only view of one gate's persisted state (core `GateSnapshot` shape). */
export interface GateSnapshotLike {
  gate: string;
  state: GateState;
  /** ISO-8601 instant of the approval, when APPROVED. */
  approvedAt: string | null;
  /** ISO-8601 instant of the rejection, when REJECTED. */
  rejectedAt: string | null;
  /** Operator identity recorded with the latest decision. */
  decidedBy: string | null;
  /** Operator note recorded with the latest decision. */
  note: string | null;
}

/** Durable record of one gate decision (core `GateRecord` shape). */
export interface GateRecordLike {
  gate: string;
  state: GateState;
  approvedAt: string | null;
  rejectedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  updatedAt: string;
}

/** One operator decision (core `GateDecisionInput` shape). */
export interface GateDecisionInputLike {
  /** Who signed off (operator identity). Optional but recorded. */
  decidedBy?: string;
  /** Operator note/reason for the decision. */
  note?: string;
  /** Injectable clock for tests; default `new Date().toISOString()`. */
  now?: string;
}

/**
 * Structural port over the durable approval store (core `ApprovalStore`
 * subset the storyboard gate needs). Supplied by the CLI bootstrap /
 * pipeline at integration; tests inject an in-memory implementation.
 */
export interface StoryboardApprovalPort {
  /** Approve the named gate (PENDING → APPROVED, gate order enforced). */
  approve(
    gate: string,
    decision?: GateDecisionInputLike,
  ): Promise<GateRecordLike>;
  /** Reject the named gate (PENDING → REJECTED). */
  reject(
    gate: string,
    decision?: GateDecisionInputLike,
  ): Promise<GateRecordLike>;
  /** Read-only snapshot of the named gate's persisted state. */
  snapshot(gate: string): Promise<GateSnapshotLike>;
}


/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thrown when paid generation is attempted while the storyboard plan or its
 * persisted gate-4 record is not APPROVED (spec §3 gate 4 stop condition).
 */
export class StoryboardNotApprovedError extends Error {
  /** Why generation was refused — every fact a caller needs to recover. */
  readonly planApprovalState: StoryboardPlan["approvalState"];
  readonly gateState: GateState | "UNKNOWN";
  readonly episodeCode: string;

  constructor(
    reason: string,
    planApprovalState: StoryboardPlan["approvalState"],
    gateState: GateState | "UNKNOWN",
    episodeCode: string,
  ) {
    super(
      `paid generation blocked: storyboard is not approved (gate 4, spec §3) — ${reason}` +
        ` [episode=${episodeCode || "none"} plan=${planApprovalState} gate=${gateState}]`,
    );
    this.name = "StoryboardNotApprovedError";
    this.planApprovalState = planApprovalState;
    this.gateState = gateState;
    this.episodeCode = episodeCode;
  }
}

/** Thrown on invalid approval-gate operations on a storyboard plan. */
export class StoryboardApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardApprovalError";
  }
}

/* ------------------------------------------------------------------ */
/* Pure state checks                                                   */
/* ------------------------------------------------------------------ */

/** True only when the persisted gate-4 record reads APPROVED. */
export function isStoryboardGateApproved(
  snapshot: Pick<GateSnapshotLike, "state"> | null | undefined,
): boolean {
  return snapshot?.state === "APPROVED";
}

/** True only when the plan itself has been marked APPROVED. */
export function isStoryboardPlanApproved(
  plan: Pick<StoryboardPlan, "approvalState">,
): boolean {
  return plan.approvalState === "APPROVED";
}

/* ------------------------------------------------------------------ */
/* The paid-generation stop condition (spec §3 gate 4)                 */
/* ------------------------------------------------------------------ */

/** Inputs to {@link assertPaidGenerationAllowed}. */
export interface PaidGenerationCheck {
  /** The storyboard plan about to be executed. */
  plan: Pick<StoryboardPlan, "approvalState" | "episodeCode">;
  /**
   * The persisted gate-4 snapshot as of NOW (fetch inside the generation
   * path — never cache an approval across a generation run).
   */
  gate: Pick<GateSnapshotLike, "state"> | null | undefined;
  /**
   * The image client about to run. Mocked clients never spend and stay
   * legal on a DRAFT plan (DIR-014 contract); only kind "real" is gated.
   */
  clientKind?: "mock" | "real";
}

/**
 * The mechanical gate-4 stop condition. Throws
 * {@link StoryboardNotApprovedError} when a REAL (paid) image client would
 * run while either the plan or the persisted gate is not APPROVED.
 *
 * Both conditions must hold — a plan marked APPROVED without a persisted
 * APPROVED gate record is treated as unapproved (defense in depth: the
 * persisted gate is the source of truth, spec §3 "approval gates are
 * persisted domain states"). A missing snapshot (store not wired) blocks
 * generation rather than allowing it — fail closed, never fail open.
 */
export function assertPaidGenerationAllowed(check: PaidGenerationCheck): void {
  const clientKind = check.clientKind ?? "real";
  if (clientKind === "mock") {
    return; // mocked planning art never spends — no gate needed (DIR-014)
  }
  const gateState: GateState | "UNKNOWN" = check.gate?.state ?? "UNKNOWN";
  const planState = check.plan.approvalState;

  if (planState !== "APPROVED") {
    throw new StoryboardNotApprovedError(
      `storyboard plan is ${planState}, not APPROVED`,
      planState,
      gateState,
      check.plan.episodeCode,
    );
  }
  if (gateState !== "APPROVED") {
    throw new StoryboardNotApprovedError(
      gateState === "UNKNOWN"
        ? "no persisted storyboard gate snapshot available — failing closed"
        : `persisted storyboard gate is ${gateState}, not APPROVED`,
      planState,
      gateState,
      check.plan.episodeCode,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Approval / rejection of the plan through the durable store          */
/* ------------------------------------------------------------------ */

/** Result of {@link approveStoryboardPlan} / {@link rejectStoryboardPlan}. */
export interface StoryboardDecisionResult {
  /** The plan, with its approval state updated to match the decision. */
  plan: StoryboardPlan;
  /** The persisted gate record written by the store. */
  record: GateRecordLike;
  /** The gate snapshot after the decision. */
  snapshot: GateSnapshotLike;
}

/**
 * Approve the storyboard (gate 4): PENDING → APPROVED in the durable store
 * (earlier gates must already be APPROVED — the store enforces §3 gate
 * order and throws {@link Error} subclasses it owns, which propagate
 * verbatim), then the plan marked APPROVED and persisted by the caller's
 * plan port. A plan that is already APPROVED never re-approves silently —
 * reopen the gate and re-present the revised plan instead.
 *
 * @throws StoryboardApprovalError on a plan that is not DRAFT
 * @throws rethrows the injected port's transition/gate-order errors verbatim
 */
export async function approveStoryboardPlan(
  plan: StoryboardPlan,
  port: StoryboardApprovalPort,
  decision: GateDecisionInputLike = {},
): Promise<StoryboardDecisionResult> {
  if (plan.approvalState !== "DRAFT") {
    throw new StoryboardApprovalError(
      `storyboard plan for ${plan.episodeCode || "episode"} is ${plan.approvalState}, ` +
        `not DRAFT — reopen the gate and re-present a revised plan to change the decision`,
    );
  }
  const record = await port.approve(STORYBOARD_GATE_ID, decision);
  if (record.state !== "APPROVED") {
    // Store contract violation — never mark the plan on a non-approval.
    throw new StoryboardApprovalError(
      `approval store returned state ${record.state} for gate "${STORYBOARD_GATE_ID}" ` +
        `after approve() — refusing to mark the plan APPROVED`,
    );
  }
  const snapshot = await port.snapshot(STORYBOARD_GATE_ID);
  return {
    plan: { ...plan, approvalState: "APPROVED" },
    record,
    snapshot,
  };
}

/**
 * Reject the storyboard (gate 4): PENDING → REJECTED in the durable store;
 * the plan is returned unchanged in approval terms (still DRAFT — it needs
 * revision before it can be presented again). Re-approval after a rejection
 * goes back through PENDING via the store's reopen, never a one-step flip
 * (spec §3 state machine).
 *
 * @throws StoryboardApprovalError on a plan that is already APPROVED
 * @throws rethrows the injected port's transition errors verbatim
 */
export async function rejectStoryboardPlan(
  plan: StoryboardPlan,
  port: StoryboardApprovalPort,
  decision: GateDecisionInputLike = {},
): Promise<StoryboardDecisionResult> {
  if (plan.approvalState === "APPROVED") {
    throw new StoryboardApprovalError(
      `storyboard plan for ${plan.episodeCode || "episode"} is already APPROVED — ` +
        `reopen the gate before rejecting (spec §3: never flip a decision in one step)`,
    );
  }
  const record = await port.reject(STORYBOARD_GATE_ID, decision);
  const snapshot = await port.snapshot(STORYBOARD_GATE_ID);
  return {
    plan: { ...plan, approvalState: plan.approvalState },
    record,
    snapshot,
  };
}

/** Read the persisted gate-4 snapshot through the port. */
export async function storyboardGateSnapshot(
  port: StoryboardApprovalPort,
): Promise<GateSnapshotLike> {
  return port.snapshot(STORYBOARD_GATE_ID);
}

/* ------------------------------------------------------------------ */
/* Re-export the contract error for callers that want one catch        */
/* ------------------------------------------------------------------ */

export { StoryboardContractError };