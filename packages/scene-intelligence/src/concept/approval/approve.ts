/**
 * Concept decision application — DIR-003 (gate 1, second half).
 *
 * The gate lives in the durable approval-gate store (CORE-008): `approve` /
 * `reject` / `reopen` mutate the persisted PENDING/APPROVED/REJECTED state and
 * the §3 gate-order check runs inside the store. This module is the bridge the
 * rest of the engine codes against:
 *
 *  - `applyConceptDecision` drives the store and mirrors the decision onto
 *    the selected option, producing the durable {@linkcode ConceptDecisionRecord};
 *  - `requireConceptApproved` is the gate-1 HARD STOP every downstream step
 *    calls first: no screenplay work while the concept gate is not APPROVED
 *    (spec §3) — it reads the store and throws
 *    {@linkcode ConceptApprovalRequiredError} otherwise;
 *  - `buildApprovedConceptRecord` projects the approved decision into the
 *    structural shape DIR-004's `generateScreenplay` accepts
 *    (`approval.state === "APPROVED"`).
 *
 * SECURITY (spec §29): all concept text is untrusted data — mirrored, stored,
 * presented; never executed or re-interpreted.
 */

import {
  buildConceptDecisionRecord,
  requireConceptDraft,
  resolveSelectedOptionId,
} from "./draft.js";
import {
  ConceptApprovalRequiredError,
  ConceptGateError,
  type ApprovalGateStorePort,
  type ConceptBridgeInput,
  type ConceptDecisionRecord,
  type ConceptDraftInput,
  type ConceptOptionRef,
  type GateDecision,
  type GateSnapshotView,
  type SelectedConceptOption,
} from "./types.js";

/** The single gate id this task owns (spec §3 gate 1). */
export const CONCEPT_GATE_ID = "concept" as const;

/**
 * Result of one decision application. `record` is the durable artifact the
 * caller persists/presents; `snapshot` is the store's read-only mirror.
 */
export interface ConceptDecisionResult {
  readonly record: ConceptDecisionRecord;
  readonly snapshot: GateSnapshotView;
}

/** Map a gate snapshot to the decision mirror fields on the record. */
function mirrorSnapshot(snapshot: GateSnapshotView): {
  state: ConceptDecisionRecord["decision"];
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
} {
  return {
    state: snapshot.state,
    decidedAt: snapshot.state === "APPROVED" ? snapshot.approvedAt : null,
    decidedBy: snapshot.decidedBy,
    note: snapshot.note,
  };
}

/**
 * Apply one operator decision to the concept gate and return the durable
 * record. Pure orchestration over the injected store — no filesystem, no
 * network. Illegal transitions (APPROVED → APPROVED etc.) throw inside the
 * store; the record is only built after the store accepted the transition.
 */
export async function applyConceptDecision(
  action: "approve" | "reject" | "reopen",
  draft: ConceptDraftInput,
  store: ApprovalGateStorePort,
  decision: GateDecision = {},
  options: { selectedOptionId?: string | null; draftedAt?: string } = {},
): Promise<ConceptDecisionResult> {
  requireConceptDraft(draft);
  // Selection is resolved BEFORE the store is touched: an invalid choice must
  // never consume the one-shot PENDING → APPROVED transition (spec §3).
  const selectedOptionId = resolveSelectedOptionId(draft, options.selectedOptionId);
  let snapshot: GateSnapshotView;
  switch (action) {
    case "approve":
      snapshot = await store.approve(CONCEPT_GATE_ID, decision);
      break;
    case "reject":
      snapshot = await store.reject(CONCEPT_GATE_ID, decision);
      break;
    case "reopen":
      snapshot = await store.reopen(CONCEPT_GATE_ID, decision);
      break;
    default: {
      const exhaustive: never = action;
      throw new ConceptGateError(
        `unknown concept-gate action ${JSON.stringify(String(exhaustive))}`,
      );
    }
  }
  const record = buildConceptDecisionRecord(
    draft,
    mirrorSnapshot(snapshot),
    { selectedOptionId, draftedAt: options.draftedAt },
  );
  return { record, snapshot };
}

/**
 * Gate-1 hard stop. Reads the persisted gate state; APPROVED passes, anything
 * else throws {@linkcode ConceptApprovalRequiredError}. Every downstream step
 * (screenplay generation first) calls this before doing any work — spec §3:
 * "no screenplay work before approval".
 *
 * @returns the APPROVED snapshot (approvedAt/decidedBy ride along for
 * provenance stamping).
 */
export async function requireConceptApproved(
  store: ApprovalGateStorePort,
): Promise<GateSnapshotView> {
  const snapshot = await store.snapshot(CONCEPT_GATE_ID);
  if (snapshot.state !== "APPROVED") {
    throw new ConceptApprovalRequiredError(
      `concept gate is ${snapshot.state}; no screenplay work before concept approval (spec gate 1)`,
    );
  }
  return snapshot;
}

/** True when the persisted gate state allows screenplay work. */
export async function isConceptApproved(
  store: ApprovalGateStorePort,
): Promise<boolean> {
  return (await store.snapshot(CONCEPT_GATE_ID)).state === "APPROVED";
}

/**
 * Project the approved decision into the structural concept record DIR-004's
 * `generateScreenplay` consumes (`approval.state: "APPROVED"`). Text fields
 * stay verbatim untrusted data. The premise bridges to the screenplay's
 * `setting`/`idea` fields; title/logline carry through unchanged.
 */
export function buildApprovedConceptRecord(
  draft: ConceptBridgeInput,
  decision: ConceptDecisionRecord,
): ApprovedConceptBridge {
  if (decision.decision !== "APPROVED") {
    throw new ConceptApprovalRequiredError(
      `concept gate is ${decision.decision}; only an APPROVED decision produces an approved-concept record (spec gate 1)`,
    );
  }
  const selected = selectOptionFields(draft.options, decision.selectedOptionId);
  if (selected === undefined) {
    throw new ConceptGateError(
      `selectedOptionId ${JSON.stringify(decision.selectedOptionId)} not among the concept options`,
    );
  }
  return {
    conceptId: draft.conceptId,
    title: selected.title,
    logline: selected.logline,
    idea: selected.premise,
    characters: [],
    setting: selected.premise,
    tone: selected.tone ?? "",
    targetRuntimeSeconds:
      selected.suggestedRuntimeSeconds ?? draft.targetRuntimeSeconds,
    aspectRatio: selected.suggestedAspectRatio ?? draft.aspectRatio,
    approval: {
      state: "APPROVED",
      approvedAt: decision.decidedAt ?? undefined,
      decidedBy: decision.decidedBy ?? undefined,
      note: decision.note ?? undefined,
      selectedOptionId: decision.selectedOptionId,
    },
  };
}

/**
 * The structural concept record DIR-004 accepts (its `ApprovedConcept` plus
 * the gate-1 provenance extras). Declared here — not imported — so the
 * approval module never depends on the screenplay module at runtime; the
 * shapes are structural twins (spec §55 seam discipline).
 */
export interface ApprovedConceptBridge {
  readonly conceptId: string;
  readonly title: string;
  readonly logline: string;
  /** Premise/idea prose — untrusted data only. */
  readonly idea: string;
  /** Cast seeds; empty until cast resolution (gate 3 territory). */
  readonly characters: readonly {
    readonly name: string;
    readonly description: string;
    readonly isNew?: boolean;
  }[];
  readonly setting: string;
  readonly tone: string;
  readonly targetRuntimeSeconds: number;
  readonly aspectRatio: string;
  readonly approval: {
    state: "APPROVED" | "DRAFT" | "PENDING" | "REJECTED";
    approvedAt?: string;
    decidedBy?: string;
    note?: string;
    selectedOptionId: string;
  };
}

/**
 * Pull the creative fields of one option (the selected one) for presentation.
 * Returns the option-ref plus the prose fields the bridge needs; unknown
 * option ids yield `undefined` (caller decides whether that is fatal).
 */
export function selectOptionFields(
  options: readonly (ConceptOptionRef & Partial<SelectedConceptOption>)[],
  selectedOptionId: string,
): SelectedConceptOption | undefined {
  const found = options.find((option) => option.optionId === selectedOptionId);
  if (found === undefined) return undefined;
  return {
    optionId: found.optionId,
    title: found.title,
    logline: found.logline ?? "",
    premise: found.premise ?? "",
    genre: found.genre ?? null,
    tone: found.tone ?? null,
    suggestedRuntimeSeconds: found.suggestedRuntimeSeconds ?? null,
    suggestedAspectRatio: found.suggestedAspectRatio ?? null,
  };
}

/**
 * Re-export shim: the CLI decision flow resolves the selected option through
 * the same helper the record builder uses — one import surface.
 */
export { resolveSelectedOptionId } from "./draft.js";
