/**
 * Concept-decision draft — DIR-003 (gate 1, first half).
 *
 * A DRAFT is created when `mmcs develop-concept` presents the developed
 * concept: it records what was presented (options, recommended option) and
 * starts the concept gate workflow as PENDING. The draft is data only — the
 * gate decision itself lives in the durable approval-gate store (CORE-008);
 * `approve.ts` mirrors that decision onto the selected option.
 *
 * SECURITY (spec §29): option titles/loglines/premises come from the director
 * model over untrusted idea prose. They are carried verbatim as inert data —
 * never executed, never parsed as instructions. IDs are shape-checked only.
 */

import {
  ConceptGateError,
  CONCEPT_DECISION_SCHEMA_VERSION,
  type ConceptDecisionRecord,
  type ConceptDraftInput,
  type ConceptOptionRef,
} from "./types.js";

/** Option-ID shape: `option_N`, N a positive integer (DIR-002 generator). */
const OPTION_ID_PATTERN = /^option_[1-9][0-9]*$/;

/** Concept-ID shape: `concept_` + hex (DIR-002 `newConceptId`). */
const CONCEPT_ID_PATTERN = /^concept_[0-9a-f]{32}$/;

/** Intake-ID shape: `idea_` + hex (DIR-001 `newIntakeId`). */
const INTAKE_ID_PATTERN = /^idea_[0-9a-f]{32}$/;

/** Reject an id that is not a non-empty, control-free string. */
function requireOpaqueId(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConceptGateError(`${field}: must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new ConceptGateError(`${field}: exceeds ${maxLength} characters`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new ConceptGateError(`${field}: must not contain control characters`);
  }
  return value;
}

/**
 * Validate a concept draft BEFORE anything is persisted or presented
 * (runbook §16 pre-request validation order). Structural checks only — the
 * option payload itself stays opaque untrusted data.
 */
export function requireConceptDraft(draft: ConceptDraftInput): ConceptDraftInput {
  if (draft === null || typeof draft !== "object") {
    throw new ConceptGateError("concept: must be an object");
  }
  requireOpaqueId(draft.conceptId, "conceptId", 200);
  if (!CONCEPT_ID_PATTERN.test(draft.conceptId)) {
    throw new ConceptGateError(
      "conceptId: must match concept_<32 hex> (concept generator contract)",
    );
  }
  requireOpaqueId(draft.intakeId, "intakeId", 200);
  if (!INTAKE_ID_PATTERN.test(draft.intakeId)) {
    throw new ConceptGateError(
      "intakeId: must match idea_<32 hex> (intake contract)",
    );
  }
  if (!Array.isArray(draft.options) || draft.options.length === 0) {
    throw new ConceptGateError("options: must be a non-empty array");
  }
  if (draft.options.length > 5) {
    throw new ConceptGateError("options: exceeds 5 (concept generator max)");
  }
  const seen = new Set<string>();
  for (const option of draft.options) {
    if (option === null || typeof option !== "object") {
      throw new ConceptGateError("options[]: must be objects");
    }
    if (!OPTION_ID_PATTERN.test(option.optionId)) {
      throw new ConceptGateError(
        `options[].optionId: must match option_<N>, got ${JSON.stringify(option.optionId)}`,
      );
    }
    if (seen.has(option.optionId)) {
      throw new ConceptGateError(
        `options[].optionId: duplicate ${JSON.stringify(option.optionId)}`,
      );
    }
    seen.add(option.optionId);
    requireOpaqueId(option.title, "options[].title", 200);
  }
  if (typeof draft.recommendedOptionId !== "string") {
    throw new ConceptGateError("recommendedOptionId: must be a string");
  }
  if (!seen.has(draft.recommendedOptionId)) {
    throw new ConceptGateError(
      "recommendedOptionId: must name one of the presented options",
    );
  }
  return draft;
}

/** Resolve the selected option id from an explicit choice or the recommendation. */
export function resolveSelectedOptionId(
  draft: ConceptDraftInput,
  chosenOptionId: string | null | undefined,
): string {
  if (chosenOptionId === undefined || chosenOptionId === null) {
    return draft.recommendedOptionId;
  }
  if (!draft.options.some((option) => option.optionId === chosenOptionId)) {
    throw new ConceptGateError(
      `chosenOptionId ${JSON.stringify(chosenOptionId)} does not name a presented option`,
    );
  }
  return chosenOptionId;
}

/**
 * Build the durable gate-1 artifact (the presented concept + its current
 * decision mirror). `decision`/`decidedAt`/`decidedBy`/`note` come from the
 * gate snapshot — this function never decides anything itself.
 */
export function buildConceptDecisionRecord(
  draft: ConceptDraftInput,
  decision: {
    state: ConceptDecisionRecord["decision"];
    decidedAt: string | null;
    decidedBy: string | null;
    note: string | null;
  },
  options: {
    selectedOptionId?: string | null;
    draftedAt?: string;
  } = {},
): ConceptDecisionRecord {
  requireConceptDraft(draft);
  const options0 = normalizeOptionRefs(draft.options);
  return {
    schemaVersion: CONCEPT_DECISION_SCHEMA_VERSION,
    conceptId: draft.conceptId,
    intakeId: draft.intakeId,
    options: options0,
    selectedOptionId: resolveSelectedOptionId(draft, options.selectedOptionId),
    decision: decision.state,
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
    note: decision.note,
    draftedAt: options.draftedAt ?? new Date().toISOString(),
  };
}

/** Normalize option refs into the frozen record shape (id + title only). */
function normalizeOptionRefs(options: readonly ConceptOptionRef[]): ConceptOptionRef[] {
  return options.map((option) => ({ optionId: option.optionId, title: option.title }));
}
