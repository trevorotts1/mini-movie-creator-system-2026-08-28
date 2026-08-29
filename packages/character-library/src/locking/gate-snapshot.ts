/**
 * Local gate-snapshot view over CORE-008's approval states.
 *
 * Kept as a structural type (identical shape to `@mmcs/core`'s
 * `GateSnapshot`) so the character-library does not import core at runtime;
 * the durable store arrives as an injected port. If the shapes drift, the
 * structural tests fail loudly.
 */

/** The persisted gate states (CORE-008 spec §3). */
export const GATE_STATES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type GateState = (typeof GATE_STATES)[number];

/**
 * The gate id CHAR-005 reads from the approval store. Matches CORE-008's
 * `"character"` gate id exactly (packages/core/src/approvals/gates.ts).
 */
export const CHARACTER_GATE_ID = "character";

/** Structural mirror of CORE-008's GateSnapshot for the character gate. */
export interface GateSnapshot {
  readonly gate: string;
  readonly state: GateState;
  /** ISO-8601 instant of the approval, when APPROVED. */
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly decidedBy: string | null;
  readonly note: string | null;
}

/** True when `value` is one of the three persisted gate states. */
export function isGateState(value: unknown): value is GateState {
  return typeof value === "string" && (GATE_STATES as readonly string[]).includes(value);
}
