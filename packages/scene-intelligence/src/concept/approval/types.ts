/**
 * Concept-approval domain types — DIR-003 (spec §3 gate 1: "Concept —
 * developed concept presented; no screenplay work before approval").
 *
 * Gate 1 turns DIR-002's {@linkcode DevelopedConcept} (the director model's
 * option set) into a DURABLE DECISION: the operator picks one option, the
 * decision is stamped from the persisted approval-gate state (CORE-008
 * `ApprovalStore`, gate id `"concept"`), and only then may screenplay work
 * begin (DIR-004 refuses anything whose `approval.state` is not APPROVED).
 *
 * SEAM DISCIPLINE (spec §55): the CORE-008 store arrives as the structural
 * {@linkcode ApprovalGateStorePort} — declared here, not imported — so this
 * module never depends on another package's runtime. The real store
 * satisfies it by structure; the acceptance test proves the drop-in.
 *
 * SECURITY (spec §29): concept text (titles, loglines, premises) is UNTRUSTED
 * DATA produced from untrusted idea prose. It is stored, presented and echoed
 * as inert data only — never executed, never re-interpreted as instructions.
 * Error messages stay value-free (ids and states, never story text).
 */

/** The three persisted approval states a concept decision can carry. */
export const CONCEPT_DECISION_STATES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type ConceptDecisionState = (typeof CONCEPT_DECISION_STATES)[number];

/** Current schema version of the serialized concept decision record. */
export const CONCEPT_DECISION_SCHEMA_VERSION = "concept-approval.schema/v1" as const;

/** One option reference carried in the decision record (id + title only). */
export interface ConceptOptionRef {
  /** Stable option ID from the concept generator (`option_N`). */
  readonly optionId: string;
  /** Option title — untrusted data, transported verbatim, never executed. */
  readonly title: string;
}

/**
 * Minimal concept shape the decision draft is built from. DIR-002's
 * `DevelopedConcept` satisfies this structurally (its options carry
 * `optionId`/`title` and it names a `recommendedOptionId`).
 */
export interface ConceptDraftInput {
  readonly conceptId: string;
  readonly intakeId: string;
  readonly options: readonly ConceptOptionRef[];
  readonly recommendedOptionId: string;
}

/**
 * Concept shape the DIR-004 bridge needs on top of the draft fields: the
 * full creative fields per option (runtime/aspect overrides) and the
 * episode-level defaults the option overrides fall back to. DIR-002's
 * `DevelopedConcept` satisfies this structurally.
 */
export interface ConceptBridgeInput extends ConceptDraftInput {
  readonly targetRuntimeSeconds: number;
  readonly aspectRatio: string;
  readonly options: readonly (ConceptOptionRef & Partial<SelectedConceptOption>)[];
}

/** The selected option's creative fields, as handed to the screenplay bridge. */
export interface SelectedConceptOption {
  readonly optionId: string;
  readonly title: string;
  readonly logline: string;
  /**
   * Premise prose. Bridges to the screenplay record's `setting` field: the
   * premise is where/when/what the story happens (writer model expands it).
   */
  readonly premise: string;
  readonly genre: string | null;
  readonly tone: string | null;
  readonly suggestedRuntimeSeconds: number | null;
  readonly suggestedAspectRatio: string | null;
}

/** Durable gate-1 artifact: what was presented, what was chosen, what was decided. */
export interface ConceptDecisionRecord {
  readonly schemaVersion: typeof CONCEPT_DECISION_SCHEMA_VERSION;
  readonly conceptId: string;
  readonly intakeId: string;
  /** The options presented to the operator (id + title, in generation order). */
  readonly options: readonly ConceptOptionRef[];
  /** The option this record currently selects (defaults to the recommended). */
  readonly selectedOptionId: string;
  /** Persisted decision state, mirrored from the approval gate. */
  readonly decision: ConceptDecisionState;
  /** ISO-8601 instant of the APPROVED decision, when APPROVED. */
  readonly decidedAt: string | null;
  /** Operator identity recorded with the decision, when given. */
  readonly decidedBy: string | null;
  /** Operator note recorded with the decision, when given. */
  readonly note: string | null;
  /** ISO-8601 instant the draft was created. */
  readonly draftedAt: string;
}

/**
 * Read-only view of one gate's persisted state — structural twin of CORE-008's
 * `GateSnapshot` (`{gate, state, approvedAt, rejectedAt, decidedBy, note}`).
 * Do not diverge: the real store must satisfy {@linkcode ApprovalGateStorePort}
 * without an adapter.
 */
export interface GateSnapshotView {
  readonly gate: string;
  readonly state: ConceptDecisionState;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly decidedBy: string | null;
  readonly note: string | null;
}

/** A decision the operator applies to the gate (CORE-008 `GateDecisionInput` twin). */
export interface GateDecision {
  /** Who signed off (operator identity). Optional but recorded. */
  readonly decidedBy?: string;
  /** Operator note/reason. */
  readonly note?: string;
  /** Injectable clock for tests; default is the store's own clock. */
  readonly now?: string;
}

/**
 * Port over the durable approval-gate store (CORE-008 `ApprovalStore`). The
 * port pins ONLY the concept gate — callers pass the literal `"concept"`;
 * the real store's wider `GateId` parameter accepts it by contravariance.
 */
export interface ApprovalGateStorePort {
  /** Read-only snapshot of the concept gate's persisted state. */
  snapshot(gate: "concept"): Promise<GateSnapshotView>;
  /** PENDING → APPROVED (gate-order enforced by the store). */
  approve(gate: "concept", decision?: GateDecision): Promise<GateSnapshotView>;
  /** PENDING → REJECTED — send the concept back for revision. */
  reject(gate: "concept", decision?: GateDecision): Promise<GateSnapshotView>;
  /** APPROVED/REJECTED → PENDING — present revised work again. */
  reopen(gate: "concept", decision?: GateDecision): Promise<GateSnapshotView>;
}

/** Base error for the concept-approval gate (value-free messages, spec §29). */
export class ConceptGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptGateError";
  }
}

/**
 * Thrown when screenplay work (or any downstream step) is attempted while the
 * concept gate is not APPROVED — the gate-1 hard stop, spec §3.
 */
export class ConceptApprovalRequiredError extends ConceptGateError {
  constructor(message: string) {
    super(message);
    this.name = "ConceptApprovalRequiredError";
  }
}
