/**
 * Gate-2 approval decision + downstream guard — DIR-008 (spec §3 gate 2).
 *
 * `approve script` is the operator's sign-off at gate 2. It requires a
 * PRESENTED, QC-passing, PENDING record and flips it to APPROVED. The
 * {@link assertGate2Open} guard is what every cast/candidate entry point
 * (DIR-009 scene parser inputs, CHAR-003/004 candidate flow) calls before
 * touching cast state — the acceptance criterion "no cast/candidate work
 * while script unapproved" is enforced HERE, in one place, not re-derived
 * per consumer.
 *
 * Decision transitions mirror the core gate machine (spec §3): only
 * PENDING → APPROVED / PENDING → REJECTED move a decision; APPROVED and
 * REJECTED records re-enter through a new presentation (`write-script`),
 * never a flip.
 */

import {
  ScriptApprovalError,
  gate2BlockedReason,
  isScriptApproved,
  type ScriptApprovalRecord,
  type ScriptApprovalSnapshot,
  type ScriptApprovalStorePort,
  type ScriptGateStatePort,
} from "./types.js";

/**
 * The guard: throw when gate 2 is not APPROVED. Call it at the top of every
 * cast/candidate entry point. The thrown message is the operator-facing
 * reason; catching callers may print it verbatim.
 */
export function assertGate2Open(gates: ScriptGateStatePort): void {
  if (!isScriptApproved(gates)) {
    throw new ScriptApprovalError(gate2BlockedReason(gates.scriptGateState()));
  }
}

/** Non-throwing variant for consumers that prefer a boolean. */
export function gate2AllowsCastWork(gates: ScriptGateStatePort): boolean {
  return isScriptApproved(gates);
}

/** Result of one `mmcs approve script` invocation. */
export interface ApprovalDecisionResult {
  exitCode: 0 | 1;
  /** The record after the decision, when one exists. */
  record: ScriptApprovalSnapshot | null;
  /** Operator-facing lines (stdout on success, stderr on rejection). */
  output: string[];
}

/** Decision payload for the operator sign-off. */
export interface ApprovalDecisionInput {
  /** Who signed off (operator identity). Optional but recorded. */
  decidedBy?: string;
  /** Operator note/reason. Optional but recorded. */
  note?: string;
  /** Injectable clock for tests; default `new Date().toISOString()`. */
  now?: string;
}

/**
 * Execute `mmcs approve script` against injected ports.
 * Pure decision logic — no process.exit, no filesystem, no network.
 */
export function runApproveScript(
  gates: ScriptGateStatePort,
  store: ScriptApprovalStorePort,
  decision: ApprovalDecisionInput = {},
): ApprovalDecisionResult {
  const now = decision.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) {
    throw new ScriptApprovalError(
      `decision "now" is not ISO-8601: ${JSON.stringify(now)}`,
    );
  }

  // Gate order (spec §3): gate 2 may only be approved after gate 1.
  if (gates.conceptGateState() !== "APPROVED") {
    return {
      exitCode: 1,
      record: store.getRecord(),
      output: [
        `Gate 1 not passed: the concept is ${gates.conceptGateState()}; script approval requires concept approval first (spec §3).`,
      ],
    };
  }

  const current = store.getRecord();
  if (current === null) {
    return {
      exitCode: 1,
      record: null,
      output: [
        "Gate 2 not satisfied: no screenplay has been presented for approval.",
        "Run `mmcs write-script` first (spec §3).",
      ],
    };
  }

  if (current.state === "APPROVED") {
    return {
      exitCode: 0,
      record: current,
      output: [
        `Script ${current.screenplayId} is already APPROVED (gate 2 complete).`,
        "Next: resolve the cast with `mmcs cast` (spec §9).",
      ],
    };
  }

  if (current.state === "REJECTED") {
    return {
      exitCode: 1,
      record: current,
      output: [
        `Script ${current.screenplayId} is REJECTED; re-present a revised screenplay instead.`,
        "Run the revision loop, then `mmcs write-script` (spec §14).",
      ],
    };
  }

  // PENDING → APPROVED, the only forward decision at gate 2.
  const decided: ScriptApprovalRecord = {
    ...current,
    state: "APPROVED",
    decidedAt: now,
    decidedBy: decision.decidedBy?.trim() ? decision.decidedBy.trim() : null,
    note: decision.note?.trim() ? decision.note.trim() : null,
    updatedAt: now,
  };
  store.save(decided);
  return {
    exitCode: 0,
    record: decided,
    output: [
      `SCRIPT APPROVED: ${decided.screenplayId} (gate 2 complete, spec §3).`,
      decision.decidedBy?.trim() ? `Approved by ${decision.decidedBy.trim()}.` : "",
      "Next: resolve the cast with `mmcs cast` (spec §9).",
    ].filter((line) => line !== ""),
  };
}

/**
 * Execute the operator REJECTING the script at gate 2 (PENDING → REJECTED).
 * Rejected records re-enter through a fresh presentation, never a flip.
 */
export function runRejectScript(
  gates: ScriptGateStatePort,
  store: ScriptApprovalStorePort,
  decision: ApprovalDecisionInput = {},
): ApprovalDecisionResult {
  const now = decision.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) {
    throw new ScriptApprovalError(
      `decision "now" is not ISO-8601: ${JSON.stringify(now)}`,
    );
  }

  const current = store.getRecord();
  if (current === null) {
    return {
      exitCode: 1,
      record: null,
      output: [
        "Gate 2 not satisfied: no screenplay has been presented for approval.",
        "Run `mmcs write-script` first (spec §3).",
      ],
    };
  }

  if (current.state !== "PENDING") {
    return {
      exitCode: 1,
      record: current,
      output: [
        `Script ${current.screenplayId} is ${current.state}; only a PENDING presentation can be rejected.`,
        current.state === "REJECTED"
          ? "It is already REJECTED."
          : "Reopen through a new presentation with `mmcs write-script` (spec §14).",
      ],
    };
  }

  const decided: ScriptApprovalRecord = {
    ...current,
    state: "REJECTED",
    decidedAt: now,
    decidedBy: decision.decidedBy?.trim() ? decision.decidedBy.trim() : null,
    note: decision.note?.trim() ? decision.note.trim() : null,
    updatedAt: now,
  };
  store.save(decided);
  return {
    exitCode: 0,
    record: decided,
    output: [
      `SCRIPT REJECTED: ${decided.screenplayId} sent back for revision (spec §14).`,
      decision.note?.trim() ? `Note: ${decision.note.trim()}` : "",
      "Revise the screenplay, then `mmcs write-script` again.",
    ].filter((line) => line !== ""),
  };
}
