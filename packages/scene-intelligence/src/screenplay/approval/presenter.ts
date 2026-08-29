/**
 * Gate-2 presentation — DIR-008 (spec §3 gate 2, §14 writer model).
 *
 * `write-script` presents a generated screenplay for approval:
 *   1. gate 1 (concept) must be APPROVED — gate order (spec §3);
 *   2. the screenplay must be QC'd with verdict "pass" (DIR-006) — spec §3:
 *      "screenplay generated and QC'd; no cast/candidate work before approval";
 *   3. presentation (re)opens gate 2 PENDING and records the QC evidence.
 *
 * Presentation is idempotent: re-running `write-script` after a revision
 * replaces the record with a fresh PENDING one and re-records QC provenance.
 * Nothing here approves — only the operator does, via `approve script`.
 */

import {
  SCRIPT_APPROVAL_SCHEMA_VERSION,
  ScriptApprovalError,
  type ScriptApprovalRecord,
  type ScriptApprovalStorePort,
  type ScriptGateStatePort,
  type ScreenplayWriterPort,
  type ScriptQcEvidence,
} from "./types.js";

/** What one `write-script` invocation produced. */
export interface PresentationResult {
  /** The persisted (or returned, when blocked) gate-2 record. */
  record: ScriptApprovalRecord | null;
  /** True when the screenplay was presented for approval. */
  presented: boolean;
  /** Operator-facing lines (inert screenplay data echoed as values only). */
  output: string[];
}

/** Validate QC evidence shape; throws ScriptApprovalError on garbage. */
function assertEvidence(evidence: ScriptQcEvidence): void {
  if (typeof evidence.screenplayId !== "string" || evidence.screenplayId.trim() === "") {
    throw new ScriptApprovalError(
      "script QC evidence is missing its screenplayId (spec §3 gate 2)",
    );
  }
  if (evidence.verdict !== "pass" && evidence.verdict !== "revise") {
    throw new ScriptApprovalError(
      `script QC evidence verdict must be "pass" or "revise", got ${JSON.stringify(evidence.verdict)}`,
    );
  }
}

/** Fresh PENDING record for a presented screenplay. */
export function pendingScriptRecord(
  screenplayId: string,
  conceptId: string,
  qc: ScriptQcEvidence,
  now: string,
  decidedBy: string | null = null,
): ScriptApprovalRecord {
  return {
    schemaVersion: SCRIPT_APPROVAL_SCHEMA_VERSION,
    screenplayId,
    conceptId,
    state: "PENDING",
    qcVerdict: qc.verdict,
    decidedAt: null,
    decidedBy,
    note: null,
    updatedAt: now,
  };
}

/**
 * Run `mmcs write-script` against injected ports.
 * Pure decision logic — no process.exit, no filesystem, no network.
 */
export function presentScreenplayForApproval(
  qc: ScriptQcEvidence,
  gates: ScriptGateStatePort,
  store: ScriptApprovalStorePort,
  writer: ScreenplayWriterPort,
  opts: { now?: string; decidedBy?: string } = {},
): PresentationResult {
  const now = opts.now ?? new Date().toISOString();
  assertEvidence(qc);

  // Gate order (spec §3): gate 2 only runs after gate 1.
  if (gates.conceptGateState() !== "APPROVED") {
    return {
      record: store.getRecord(),
      presented: false,
      output: [
        `Gate 1 not passed: the concept is ${gates.conceptGateState()}; no screenplay work before concept approval (spec §3).`,
        "Run `mmcs approve concept` first.",
      ],
    };
  }

  // Spec §3: the screenplay must be generated AND QC'd before the gate opens.
  if (qc.verdict !== "pass") {
    return {
      record: store.getRecord(),
      presented: false,
      output: [
        "Script QC verdict is \"revise\": the screenplay is not presented for approval.",
        "Run the script revision loop (`mmcs write-script` after revision, spec §14).",
      ],
    };
  }

  const written = writer.writeScreenplay();
  if (written.screenplayId !== qc.screenplayId) {
    throw new ScriptApprovalError(
      `script QC evidence covers ${JSON.stringify(qc.screenplayId)}, but the writer produced ${JSON.stringify(written.screenplayId)}`,
    );
  }

  const record = pendingScriptRecord(
    written.screenplayId,
    written.conceptId,
    qc,
    now,
    opts.decidedBy?.trim() ? opts.decidedBy.trim() : null,
  );
  store.save(record);
  return {
    record,
    presented: true,
    output: [
      `Screenplay "${written.title}" written: ${written.sceneCount} scene(s), ${written.characterCount} character(s).`,
      "Script QC passed — STOP at gate 2 (script approval, spec §3).",
      "Approve with `mmcs approve script`.",
    ],
  };
}
