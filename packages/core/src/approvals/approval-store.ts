/// <reference types="node" />
/**
 * Durable approval-gate store (spec §3: "approval gates are persisted domain
 * states"; §25 approvals records).
 *
 * Backed by ONE JSON document per project written atomically (unique temp
 * file + fsync + rename — the same primitive the recovery checkpoint uses),
 * so a `kill -9` at any instant leaves either the previous valid document or
 * the new one, never a partial write. Reads of a corrupt document throw —
 * external damage must surface, not silently reset the gates.
 *
 * Contract:
 * - Every gate of a project starts PENDING and is persisted from first
 *   creation (a fresh store persists all six PENDING records immediately).
 * - `approve` / `reject` / `reopen` are the only mutators; each validates
 *   the transition against the §3 state machine and throws
 *   {@link GateTransitionError} on anything illegal — illegal transitions
 *   never touch disk.
 * - `approve(gate)` additionally enforces §3 gate order: an earlier gate
 *   still PENDING/REJECTED blocks approval (GateOrderError).
 * - An in-process write queue serializes concurrent updates; callers needing
 *   cross-process safety use `state/locks/` (the recovery service owns that
 *   protocol).
 * - `snapshot(gate)` returns the read-only view consumers (VID-014
 *   `ApprovalGatePort`, QC-011 human review) read — never a live reference.
 */

import { join } from "node:path";
import { atomicWriteFile, readJsonFileOrNull } from "../recovery/atomic-write.js";
import {
  GATE_IDS,
  GATE_STATES,
  UnknownGateError,
  pendingGateRecord,
  toGateSnapshot,
  type GateId,
  type GateRecord,
  type GateSnapshot,
  type GateState,
} from "./gates.js";
import {
  assertGateOrder,
  requireGateTransition,
} from "../state-machine/gate-machine.js";

export const APPROVALS_FILE = "approvals.json";

/** Persisted document shape (schemaVersion gates structural changes). */
export const APPROVALS_SCHEMA_VERSION = 1 as const;

export interface ApprovalsDocument {
  schemaVersion: typeof APPROVALS_SCHEMA_VERSION;
  /** ISO-8601 instant of the last write. */
  updatedAt: string;
  /** Gate id -> record, all six gates always present. */
  gates: Record<GateId, GateRecord>;
}

/** A decision applied to a gate. */
export type GateDecisionInput = {
  /** Who signed off (operator identity, e.g. "trevor"). Optional but logged. */
  decidedBy?: string;
  /** Operator note/reason for the decision. */
  note?: string;
  /** Injectable clock for tests; default `new Date().toISOString()`. */
  now?: string;
};

/** Thrown on a corrupt approvals document (external damage must surface). */
export class ApprovalsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalsStoreError";
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ApprovalsStoreError(
      `approvals field "${field}" is not an ISO-8601 timestamp: ${JSON.stringify(value)}`,
    );
  }
}

/** Validate + normalize a parsed document. Throws ApprovalsStoreError on a structurally unusable one. */
export function normalizeApprovalsDocument(raw: unknown): ApprovalsDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApprovalsStoreError("approvals document must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== APPROVALS_SCHEMA_VERSION) {
    throw new ApprovalsStoreError(
      `unsupported approvals schemaVersion ${JSON.stringify(doc.schemaVersion)} — expected ${APPROVALS_SCHEMA_VERSION}`,
    );
  }
  const gatesRaw = doc.gates;
  if (gatesRaw === null || typeof gatesRaw !== "object" || Array.isArray(gatesRaw)) {
    throw new ApprovalsStoreError('approvals document is missing its "gates" object');
  }
  // Unknown gate keys are external damage (hand-edited or foreign data): they
  // must surface here, not silently vanish on the next write.
  const known = new Set<string>(GATE_IDS);
  for (const key of Object.keys(gatesRaw as Record<string, unknown>)) {
    if (!known.has(key)) {
      throw new ApprovalsStoreError(
        `approvals document has unknown gate ${JSON.stringify(key)} (spec §3 gates: ${GATE_IDS.join(", ")})`,
      );
    }
  }
  const updatedAt = typeof doc.updatedAt === "string" ? doc.updatedAt : "";
  assertIsoTimestamp(updatedAt || "missing", "updatedAt");

  const gates = {} as Record<GateId, GateRecord>;
  for (const gate of GATE_IDS) {
    const entry = (gatesRaw as Record<string, unknown>)[gate];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApprovalsStoreError(`gate "${gate}" is missing its record`);
    }
    const rec = entry as Record<string, unknown>;
    const state = rec.state;
    if (
      typeof state !== "string" ||
      !(GATE_STATES as readonly string[]).includes(state)
    ) {
      throw new ApprovalsStoreError(
        `gate "${gate}" has corrupt state ${JSON.stringify(state)}`,
      );
    }
    const asIso = (field: string): string | null => {
      const v = rec[field];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        throw new ApprovalsStoreError(`gate "${gate}" field "${field}" must be a string`);
      }
      assertIsoTimestamp(v, `${gate}.${field}`);
      return v;
    };
    const asText = (field: string): string | null => {
      const v = rec[field];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        throw new ApprovalsStoreError(`gate "${gate}" field "${field}" must be a string`);
      }
      return v;
    };
    const record: GateRecord = {
      gate,
      state: state as GateState,
      approvedAt: asIso("approvedAt"),
      rejectedAt: asIso("rejectedAt"),
      decidedBy: asText("decidedBy"),
      note: asText("note"),
      updatedAt: asIso("updatedAt") ?? updatedAt,
    };
    if (record.state === "APPROVED" && record.approvedAt === null) {
      throw new ApprovalsStoreError(`gate "${gate}" is APPROVED without an approvedAt`);
    }
    if (record.state === "REJECTED" && record.rejectedAt === null) {
      throw new ApprovalsStoreError(`gate "${gate}" is REJECTED without a rejectedAt`);
    }
    gates[gate] = record;
  }
  return {
    schemaVersion: APPROVALS_SCHEMA_VERSION,
    updatedAt,
    gates,
  };
}

/** A fresh all-PENDING document (first boot of a project). */
export function emptyApprovalsDocument(now: string): ApprovalsDocument {
  const gates = {} as Record<GateId, GateRecord>;
  for (const gate of GATE_IDS) {
    gates[gate] = pendingGateRecord(gate, now);
  }
  return { schemaVersion: APPROVALS_SCHEMA_VERSION, updatedAt: now, gates };
}

export class ApprovalStore {
  readonly dir: string;
  readonly filePath: string;
  private cached: ApprovalsDocument | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, opts?: { fileName?: string }) {
    if (!dir || dir.trim() === "") {
      throw new ApprovalsStoreError("approvals store dir is required");
    }
    this.dir = dir;
    this.filePath = join(dir, opts?.fileName ?? APPROVALS_FILE);
  }

  /** Load the persisted document, creating an all-PENDING one when absent (first boot). */
  async load(): Promise<ApprovalsDocument> {
    const raw = await readJsonFileOrNull<unknown>(this.filePath);
    if (raw === null) {
      const fresh = freezeDocument(emptyApprovalsDocument(new Date().toISOString()));
      await this.persist(fresh);
      return fresh;
    }
    this.cached = freezeDocument(normalizeApprovalsDocument(raw));
    return this.cached;
  }

  /** Current document, loading from disk on first access. */
  async get(): Promise<ApprovalsDocument> {
    if (this.cached === null) {
      return this.load();
    }
    return this.cached;
  }

  /** Read-only snapshot of one gate for consumers (VID-014 ApprovalGatePort shape). */
  async snapshot(gate: GateId): Promise<GateSnapshot> {
    if (!(GATE_IDS as readonly string[]).includes(gate)) {
      throw new UnknownGateError(String(gate));
    }
    const doc = await this.get();
    return toGateSnapshot(doc.gates[gate]);
  }

  /** Read-only snapshots of all six gates, in spec §3 order. */
  async snapshots(): Promise<GateSnapshot[]> {
    const doc = await this.get();
    return GATE_IDS.map((gate) => toGateSnapshot(doc.gates[gate]));
  }

  /** State map for the gate-order check. */
  private async stateMap(): Promise<Record<GateId, GateState>> {
    const doc = await this.get();
    const map = {} as Record<GateId, GateState>;
    for (const gate of GATE_IDS) {
      map[gate] = doc.gates[gate].state;
    }
    return map;
  }

  /** Approve a gate (PENDING → APPROVED only, earlier gates must be APPROVED). */
  async approve(gate: GateId, decision: GateDecisionInput = {}): Promise<GateRecord> {
    if (!(GATE_IDS as readonly string[]).includes(gate)) {
      throw new UnknownGateError(String(gate));
    }
    return this.applyDecision(gate, "APPROVED", decision, { enforceOrder: true });
  }

  /** Reject a gate (PENDING → REJECTED only) — send the work back for revision. */
  async reject(gate: GateId, decision: GateDecisionInput = {}): Promise<GateRecord> {
    if (!(GATE_IDS as readonly string[]).includes(gate)) {
      throw new UnknownGateError(String(gate));
    }
    return this.applyDecision(gate, "REJECTED", decision);
  }

  /** Reopen a decided gate back to PENDING for revised work (APPROVED/REJECTED → PENDING). */
  async reopen(gate: GateId, decision: GateDecisionInput = {}): Promise<GateRecord> {
    if (!(GATE_IDS as readonly string[]).includes(gate)) {
      throw new UnknownGateError(String(gate));
    }
    return this.applyDecision(gate, "PENDING", decision);
  }

  /** Apply one decision after validating it; illegal transitions throw, disk untouched. */
  private async applyDecision(
    gate: GateId,
    to: GateState,
    decision: GateDecisionInput,
    opts?: { enforceOrder?: boolean },
  ): Promise<GateRecord> {
    const now = decision.now ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(now))) {
      throw new ApprovalsStoreError(`decision "now" is not ISO-8601: ${JSON.stringify(now)}`);
    }
    const run = async (): Promise<GateRecord> => {
      const current = this.cached ?? (await this.load());
      const from = current.gates[gate].state;
      requireGateTransition(from, to, gate);
      if (opts?.enforceOrder) {
        assertGateOrder(gate, await this.stateMap());
      }
      const record: GateRecord = {
        gate,
        state: to,
        approvedAt: to === "APPROVED" ? now : null,
        rejectedAt: to === "REJECTED" ? now : null,
        decidedBy: decision.decidedBy?.trim() ? decision.decidedBy.trim() : null,
        note: decision.note?.trim() ? decision.note.trim() : null,
        updatedAt: now,
      };
      const doc: ApprovalsDocument = {
        schemaVersion: APPROVALS_SCHEMA_VERSION,
        updatedAt: now,
        gates: { ...current.gates, [gate]: record },
      };
      await this.persist(doc);
      return freezeRecord(record);
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  /** Persist the full document atomically and cache it. */
  private async persist(doc: ApprovalsDocument): Promise<void> {
    const serialized = `${JSON.stringify(doc, null, 2)}\n`;
    await atomicWriteFile(this.filePath, serialized);
    this.cached = freezeDocument(doc);
  }
}

/**
 * Deep-freeze a document so consumers cannot corrupt the store's in-memory
 * state through the reference `get()`/`load()` return (read-only discipline:
 * mutations go through approve/reject/reopen only).
 */
function freezeDocument(doc: ApprovalsDocument): ApprovalsDocument {
  for (const gate of GATE_IDS) {
    Object.freeze(doc.gates[gate]);
  }
  Object.freeze(doc.gates);
  return Object.freeze(doc);
}

/** Freeze one returned record so callers cannot mutate store state through it. */
function freezeRecord(record: GateRecord): GateRecord {
  return Object.freeze(record);
}