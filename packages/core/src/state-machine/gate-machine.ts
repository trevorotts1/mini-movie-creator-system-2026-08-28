/**
 * The gate state machine (spec §3). Approval gates are persisted domain
 * states; this module owns which transitions between them are legal and
 * throws {@link GateTransitionError} on anything illegal.
 *
 * Core rules from spec §3:
 * - Every gate starts PENDING. Nothing advances past a gate without explicit
 *   operator sign-off.
 * - PENDING → APPROVED: the only path forward (explicit operator sign-off).
 * - PENDING → REJECTED: the operator sends work back for revision
 *   (spec workflow step 9: "choose Approve / 1-2-3 / Try Again").
 * - APPROVED → PENDING: an operator reopens a gate to revise (spec workflow
 *   step 23: "revise individual shots" re-enters the gate cycle).
 * - APPROVED → REJECTED and REJECTED → APPROVED are illegal: an operator
 *   never flips a decision in one step; reopening a rejected gate goes back
 *   through PENDING (a deliberate, visible re-review).
 * - REJECTED → PENDING is legal: the revised work is presented again.
 * - Same-state self-transitions are illegal — a transition that records
 *   nothing changes nothing.
 * - The six gates are independent records; the SEQUENCE in which they may be
 *   approved (concept before script before character before storyboard
 *   before rough-cut before canon) is enforced by {@link assertGateOrder},
 *   so an out-of-order sign-off fails loudly instead of silently unlocking
 *   downstream creative work.
 */

import {
  GATE_IDS,
  GATE_STATES,
  type GateId,
  type GateState,
} from "../approvals/gates.js";

/**
 * Legal transitions under spec §3, as a table: each source state maps to the
 * set of target states reachable from it.
 */
export const LEGAL_GATE_TRANSITIONS: Readonly<
  Record<GateState, readonly GateState[]>
> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: ["PENDING"],
  REJECTED: ["PENDING"],
};

/** True when `from` may legally transition to `to` under spec §3. */
export function isLegalGateTransition(from: GateState, to: GateState): boolean {
  return LEGAL_GATE_TRANSITIONS[from].includes(to);
}

/** Thrown when a gate transition violates the §3 state machine. */
export class GateTransitionError extends Error {
  readonly gate: GateId | null;
  readonly from: GateState | null;
  readonly to: GateState | null;

  constructor(message: string, gate?: GateId, from?: GateState, to?: GateState) {
    super(message);
    this.name = "GateTransitionError";
    this.gate = gate ?? null;
    this.from = from ?? null;
    this.to = to ?? null;
  }
}

/**
 * Thrown when a gate is approved while an earlier gate in the §3 order is
 * not yet APPROVED (concept before script before … before canon).
 */
export class GateOrderError extends Error {
  readonly gate: GateId;
  readonly blockingGate: GateId;
  readonly blockingState: GateState;

  constructor(gate: GateId, blockingGate: GateId, blockingState: GateState) {
    super(
      `gate "${gate}" cannot be approved while earlier gate "${blockingGate}" ` +
        `is ${blockingState} (spec §3 gate order: ${GATE_IDS.join(" → ")})`,
    );
    this.name = "GateOrderError";
    this.gate = gate;
    this.blockingGate = blockingGate;
    this.blockingState = blockingState;
  }
}

/**
 * Validate one proposed transition and return the target state, or throw
 * {@link GateTransitionError}. Pure — the approval store calls this before
 * persisting any state change.
 */
export function requireGateTransition(
  from: GateState,
  to: GateState,
  gate?: GateId,
): GateState {
  if (!(GATE_STATES as readonly string[]).includes(from)) {
    throw new GateTransitionError(
      `unknown gate state ${JSON.stringify(from)}`,
      gate,
    );
  }
  if (!(GATE_STATES as readonly string[]).includes(to)) {
    throw new GateTransitionError(`unknown gate state ${JSON.stringify(to)}`, gate);
  }
  if (!isLegalGateTransition(from, to)) {
    throw new GateTransitionError(
      `illegal gate transition ${from} -> ${to}` +
        (gate ? ` for gate "${gate}"` : "") +
        " (spec §3: only explicit operator sign-off advances a gate)",
      gate,
      from,
      to,
    );
  }
  return to;
}

/**
 * Gate-order check for pipelines that present gates in sequence (spec §3
 * workflow: concept → script → character → storyboard → rough-cut → canon).
 * A gate may be APPROVED only when every earlier gate is also APPROVED —
 * the "no screenplay work before concept approval" invariant, enforced at
 * approval time.
 */
export function assertGateOrder(
  gate: GateId,
  approvals: Readonly<Record<GateId, GateState>>,
): void {
  const position = GATE_IDS.indexOf(gate);
  if (position === -1) {
    throw new GateTransitionError(`unknown gate ${JSON.stringify(gate)}`);
  }
  for (let i = 0; i < position; i += 1) {
    const earlier = GATE_IDS[i] as GateId;
    const state = approvals[earlier];
    if (state !== "APPROVED") {
      throw new GateOrderError(gate, earlier, state ?? "PENDING");
    }
  }
}

/**
 * The ordered gate list, for pipelines that walk the six gates in spec §3
 * order (introspection, CLI progress rendering).
 */
export const GATE_ORDER: readonly GateId[] = GATE_IDS;