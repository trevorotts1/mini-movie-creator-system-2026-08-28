/**
 * Concept-approval barrel — DIR-003 (gate 1).
 *
 * Exposes the gate-1 contract for the CLI (`mmcs develop-concept` +
 * `mmcs approve concept`), the durable decision record, and the hard stop
 * every downstream step calls: `requireConceptApproved`. The CORE-008
 * `ApprovalStore` satisfies {@linkcode ApprovalGateStorePort} structurally —
 * no adapter, no runtime dependency on `@mmcs/core` from this module.
 */

export {
  CONCEPT_DECISION_SCHEMA_VERSION,
  CONCEPT_DECISION_STATES,
  ConceptApprovalRequiredError,
  ConceptGateError,
  type ApprovalGateStorePort,
  type ConceptBridgeInput,
  type ConceptDecisionRecord,
  type ConceptDecisionState,
  type ConceptDraftInput,
  type ConceptOptionRef,
  type GateDecision,
  type GateSnapshotView,
  type SelectedConceptOption,
} from "./types.js";
export {
  buildConceptDecisionRecord,
  requireConceptDraft,
  resolveSelectedOptionId,
} from "./draft.js";
export {
  CONCEPT_GATE_ID,
  applyConceptDecision,
  buildApprovedConceptRecord,
  isConceptApproved,
  requireConceptApproved,
  selectOptionFields,
  type ApprovedConceptBridge,
  type ConceptDecisionResult,
} from "./approve.js";
