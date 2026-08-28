/**
 * The six human approval gates (spec §3 "HUMAN APPROVAL GATES — EXACT STOP
 * CONDITIONS") and the approval states they persist as domain state.
 *
 * Gate ids are stable API/CLI identifiers. `rough-cut` matches the spec's
 * "Rough cut" gate and the `ApprovalGatePort` contract VID-014 already codes
 * against (packages/remotion-runtime/src/final-render/contract.ts) — the two
 * must never drift. Approval states are the persisted domain states (spec §3:
 * "approval gates are persisted domain states"); the transition legality
 * lives in `packages/core/src/state-machine/gate-machine.ts`.
 */

/** The six spec §3 gates by stable id, in mandatory order. */
export const GATE_IDS = [
  "concept",
  "script",
  "character",
  "storyboard",
  "rough-cut",
  "canon",
] as const;

export type GateId = (typeof GATE_IDS)[number];

/** Approval states a gate can be in (persisted domain state, spec §3). */
export const GATE_STATES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type GateState = (typeof GATE_STATES)[number];

/**
 * Operator-facing gate names, verbatim from spec §3, for messages, CLI
 * output and logs. Index-aligned with {@link GATE_IDS}.
 */
export const GATE_LABELS: readonly string[] = [
  "Concept",
  "Script",
  "New character selection/lock",
  "Storyboard",
  "Rough cut",
  "Canon/Series Bible update",
];

/** 1-based position of a gate in the mandatory §3 order (concept = 1). */
export function gateNumber(gate: GateId): number {
  const index = GATE_IDS.indexOf(gate);
  if (index === -1) {
    throw new UnknownGateError(String(gate));
  }
  return index + 1;
}

/** True when `value` is one of the six stable gate ids. */
export function isGateId(value: unknown): value is GateId {
  return typeof value === "string" && (GATE_IDS as readonly string[]).includes(value);
}

/** True when `value` is one of the three persisted approval states. */
export function isGateState(value: unknown): value is GateState {
  return typeof value === "string" && (GATE_STATES as readonly string[]).includes(value);
}

/** Thrown for a gate id outside the six spec §3 gates. */
export class UnknownGateError extends Error {
  constructor(value: string) {
    super(`unknown approval gate ${JSON.stringify(value)} (spec §3)`);
    this.name = "UnknownGateError";
  }
}

/** Durable, persisted record of one gate's approval state (spec §3/§25). */
export interface GateRecord {
  gate: GateId;
  state: GateState;
  /** ISO-8601 instant of the most recent APPROVED decision, when APPROVED. */
  approvedAt: string | null;
  /** ISO-8601 instant of the most recent REJECTED decision, when REJECTED. */
  rejectedAt: string | null;
  /** Operator identity recorded with the latest decision, when one was given. */
  decidedBy: string | null;
  /** Operator note/reason recorded with the latest decision. */
  note: string | null;
  /** ISO-8601 instant of the last state change of any kind. */
  updatedAt: string;
}

/**
 * What the approval store hands read-only consumers (render pipeline, QC
 * human review). Structural superset of VID-014's `GateSnapshot`
 * (`{gate, state, approvedAt}`) so the port matches exactly.
 */
export interface GateSnapshot {
  gate: GateId;
  state: GateState;
  /** ISO-8601 instant of the approval, when APPROVED. */
  approvedAt: string | null;
  rejectedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

/** Project a durable record down to the consumer-facing snapshot. */
export function toGateSnapshot(record: GateRecord): GateSnapshot {
  return {
    gate: record.gate,
    state: record.state,
    approvedAt: record.approvedAt,
    rejectedAt: record.rejectedAt,
    decidedBy: record.decidedBy,
    note: record.note,
  };
}

/** Fresh PENDING record for a gate that has never been decided. */
export function pendingGateRecord(gate: GateId, now: string): GateRecord {
  return {
    gate,
    state: "PENDING",
    approvedAt: null,
    rejectedAt: null,
    decidedBy: null,
    note: null,
    updatedAt: now,
  };
}