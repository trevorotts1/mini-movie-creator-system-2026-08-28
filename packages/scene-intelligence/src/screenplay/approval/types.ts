/**
 * Script approval gate types — DIR-008 (runbook §24, spec §3 gate 2 / §14).
 *
 * Gate 2 is the SCRIPT hard-stop (spec §3): "screenplay generated and QC'd;
 * no cast/candidate work before approval." This module owns the gate-2
 * decision record and the guard every downstream entry point (cast
 * resolution, 3-candidate character work — DIR-009/CHAR-003/CHAR-004) calls
 * before touching cast state.
 *
 * The durable six-gate store lives in CORE-008
 * (`packages/core/src/approvals/`); gate ORDER lives in its state machine.
 * This module deliberately does NOT import core: scene-intelligence has no
 * core dependency, so the store and gate states arrive as STRUCTURAL ports
 * (spec §55: split shared seams behind interfaces). The CLI bootstrap wires
 * the real `ApprovalStore` into these ports at integration — same pattern
 * CHAR-004 used for `GateStatePort`.
 *
 * State vocabulary mirrors the persisted gate states (PENDING / APPROVED /
 * REJECTED) so the port maps 1:1 onto `core`'s `GateState`.
 *
 * Story/script text is UNTRUSTED DATA (spec §29): titles, loglines and
 * screenplay prose are carried as opaque values and echoed inertly — never
 * parsed as instructions, shell, or code.
 */

/** Version of the gate-2 decision record schema (bump on breaking changes). */
export const SCRIPT_APPROVAL_SCHEMA_VERSION = 1 as const;

/**
 * Gate states this module understands. Structurally identical to the six-gate
 * store's `GateState` (spec §3: persisted domain states).
 */
export const SCRIPT_GATE_STATES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ScriptGateState = (typeof SCRIPT_GATE_STATES)[number];

/**
 * Critic verdict vocabulary DIR-006 emits (schema.ts `CRITIC_VERDICTS`).
 * Structural — any adapter returning these strings satisfies the port.
 */
export type CriticVerdictLike = "pass" | "revise";

/** Evidence that the screenplay passed script QC (DIR-006) before gate 2. */
export interface ScriptQcEvidence {
  /** Screenplay id the critique reviewed — must match the presented one. */
  screenplayId: string;
  /** DIR-006 critic verdict: "pass" only when clean enough for approval. */
  verdict: CriticVerdictLike;
  /** id of the critic model that produced the verdict (provenance, spec §48). */
  criticModelId: string | null;
}

/**
 * The durable gate-2 decision record. One per screenplay presentation;
 * persisted by the injected store port.
 */
export interface ScriptApprovalRecord {
  schemaVersion: typeof SCRIPT_APPROVAL_SCHEMA_VERSION;
  /** Screenplay this record gates. */
  screenplayId: string;
  /** Concept the screenplay came from (provenance). */
  conceptId: string;
  /** PENDING until the operator decides at gate 2. */
  state: ScriptGateState;
  /** QC verdict recorded at presentation time. */
  qcVerdict: CriticVerdictLike;
  /** ISO-8601 instant of the latest decision, when one exists. */
  decidedAt: string | null;
  /** Operator identity recorded with the decision, when given. */
  decidedBy: string | null;
  /** Operator note/reason (e.g. what to revise). */
  note: string | null;
  /** ISO-8601 instant of the last record change of any kind. */
  updatedAt: string;
}

/** Immutable read view handed back to callers — never a live store reference. */
export type ScriptApprovalSnapshot = Readonly<ScriptApprovalRecord>;

/**
 * Structural port over the six-gate store's state map (CORE-008
 * `ApprovalStore`). The CLI reads it to enforce stop conditions; tests use
 * in-memory doubles.
 */
export interface ScriptGateStatePort {
  /** Current gate-1 (concept) state — gate 2 may only run after it. */
  conceptGateState(): ScriptGateState;
  /** Current gate-2 (script) state. */
  scriptGateState(): ScriptGateState;
}

/**
 * Convenience view many downstream tasks already code against (CHAR-004's
 * `GateStatePort.isScriptApproved`). True only when gate 2 is APPROVED.
 */
export function isScriptApproved(gates: ScriptGateStatePort): boolean {
  return gates.scriptGateState() === "APPROVED";
}

/**
 * Durable store port for the gate-2 decision record. The CLI wires the
 * project's JSON document store at integration; tests inject memory maps.
 * Synchronous by contract — the CLI bootstrap owns any async adaptation.
 */
export interface ScriptApprovalStorePort {
  /** The current record, or null when the screenplay was never presented. */
  getRecord(): ScriptApprovalRecord | null;
  /** Persist `record` (implementations must replace, not merge). */
  save(record: ScriptApprovalRecord): void;
}

/** Writer-model port: produce a screenplay from the approved concept. */
export interface ScreenplayWriterPort {
  /** Run DIR-004's generator; returns the produced screenplay summary. */
  writeScreenplay(): {
    screenplayId: string;
    conceptId: string;
    title: string;
    sceneCount: number;
    characterCount: number;
  };
}

/** thrown for every illegal gate-2 action. */
export class ScriptApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptApprovalError";
  }
}

/** The message cast/candidate entry points print when gate 2 is closed. */
export function gate2BlockedReason(state: ScriptGateState): string {
  return (
    `Gate 2 not passed: the script is ${state}; no cast/candidate work before ` +
    "script approval (spec §3). Run `mmcs approve script` first."
  );
}
