/**
 * LOCK CHARACTER approval → canonical transition (spec §3 gate 3, §9).
 *
 * The one canonical-state machine for the character library. CHAR-003's
 * candidate flow ends at APPROVED (a selection); this module owns the
 * remaining transition — LOCK CHARACTER approval flips the approved
 * candidate's assets DRAFT→APPROVED→CANONICAL and the character itself
 * APPROVED→CANONICAL. Only then does the character auto-reuse downstream
 * (spec §9: "Only APPROVED/CANONICAL assets auto-reuse").
 *
 * Invariants enforced here (spec §9, verbatim where quoted):
 * - "LOCK CHARACTER approval → only then CANONICAL" — locking without the
 *   gate-3 character approval on record throws {@link LockNotApprovedError};
 *   nothing is mutated when it throws.
 * - "Rejected candidates are never used later" — a REJECTED candidate can
 *   never reach CANONICAL; {@link assertCanonicalizable} rejects the terminal
 *   state outright (and the shared transition table has no REJECTED →
 *   CANONICAL edge at all).
 * - Canonical transitions are single-shot: a second lock of an already
 *   canonical character throws {@link CharacterAlreadyLockedError} (a
 *   transition that records nothing changes nothing).
 *
 * Pure domain logic: no DB, no provider calls, no clock. Callers pass `now`
 * and the gate snapshot they read from CORE-008's durable approval store.
 */

import {
  ALLOWED_TRANSITIONS,
  ASSET_STATES,
  CandidateStateError,
  isTransitionAllowed,
  type AssetState,
} from "../candidates/candidate-state.js";
import {
  CharacterAlreadyLockedError,
  ForeignAssetError,
  LockNotApprovedError,
  UnknownLockCharacterError,
} from "./errors.js";
import {
  CHARACTER_GATE_ID,
  isGateState,
  type GateSnapshot,
  type GateState,
} from "./gate-snapshot.js";

export {
  ALLOWED_TRANSITIONS,
  ASSET_STATES,
  assertTransition,
  isTransitionAllowed,
  CandidateStateError,
} from "../candidates/candidate-state.js";
export type { AssetState } from "../candidates/candidate-state.js";
export {
  CharacterAlreadyLockedError,
  ForeignAssetError,
  LockNotApprovedError,
  UnknownLockCharacterError,
} from "./errors.js";
export {
  CHARACTER_GATE_ID,
  GATE_STATES,
  isGateState,
  type GateSnapshot,
  type GateState,
} from "./gate-snapshot.js";
export {
  CharacterLockService,
  type AssetRecordStore,
  type CharacterLockServiceDeps,
  type CharacterRecordStore,
  type LockEvent,
  type LockResult,
} from "./service.js";

/**
 * The gate states that count as LOCK CHARACTER approval. Only an explicit
 * APPROVED decision by the operator counts (spec §3: "Nothing advances past
 * a gate without explicit operator sign-off"). PENDING and REJECTED both
 * mean "not approved".
 */
export const LOCK_APPROVING_STATES: readonly GateState[] = ["APPROVED"];

/** A character record this module can lock, structurally (see ports). */
export interface LockableCharacter {
  readonly characterId: string;
  readonly state: AssetState;
}

/** One reference-pack/candidate asset the lock flips DRAFT→APPROVED→CANONICAL. */
export interface LockableAsset {
  readonly assetId: string;
  readonly characterId: string;
  readonly state: AssetState;
}

/** Read-only view over the durable gate-3 record (CORE-008 ApprovalStore). */
export interface CharacterGateReader {
  /** The current character-gate snapshot, or null when no store is wired. */
  characterGate(): GateSnapshot | null;
}

/** True when the gate snapshot counts as LOCK CHARACTER approval. */
export function isLockApproved(gate: GateSnapshot | null): boolean {
  if (gate === null) {
    return false;
  }
  if (!isGateState(gate.state)) {
    return false;
  }
  return LOCK_APPROVING_STATES.includes(gate.state);
}

/**
 * Validate a proposed canonical transition for one asset/character state.
 * Spec §9 rules: the shared table must allow the edge and REJECTED can never
 * be the source of a canonical transition. Throws {@link CandidateStateError}
 * on an illegal edge; the REJECTED case throws with an explicit reason so
 * callers can distinguish "wrong order" from "rejected forever".
 */
export function assertCanonicalizable(state: AssetState): void {
  if (state === "REJECTED") {
    throw new CandidateStateError(
      state,
      "CANONICAL",
      "REJECTED candidates are terminal and never become CANONICAL (spec §9)",
    );
  }
  if (!isTransitionAllowed(state, "CANONICAL")) {
    throw new CandidateStateError(
      state,
      "CANONICAL",
      "only APPROVED assets may become CANONICAL",
    );
  }
}

/** True when the state may still legally reach CANONICAL (directly or via APPROVED). */
export function canBecomeCanonical(state: AssetState): boolean {
  if (state === "REJECTED" || state === "RETIRED") {
    return false;
  }
  // Walk the shared transition table from `state`; CANONICAL reachable means
  // the asset can still be locked later.
  const queue: AssetState[] = [state];
  const seen = new Set<AssetState>(queue);
  while (queue.length > 0) {
    const current = queue.shift() as AssetState;
    if (current === "CANONICAL") {
      return true;
    }
    for (const next of ALLOWED_TRANSITIONS[current]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Verify every supplied state is from the shared asset-state vocabulary. */
export function assertKnownAssetStates(states: readonly AssetState[]): void {
  for (const state of states) {
    if (!(ASSET_STATES as readonly string[]).includes(state)) {
      throw new CandidateStateError(
        state,
        "CANONICAL",
        `unknown asset state ${JSON.stringify(state)}`,
      );
    }
  }
}
