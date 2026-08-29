/// <reference types="node" />
/**
 * Durable human-review store (spec §20 "human REVIEW state", spec §3
 * discipline: approval gates — and the shot-level REVIEW verdict — are
 * persisted domain states; spec §37 durable DB via JSON documents until the
 * SQL repository layer lands).
 *
 * One JSON document per project, written atomically (unique temp file +
 * fsync + rename — the same primitive CORE-008's ApprovalStore uses), so a
 * `kill -9` at any instant leaves either the previous valid document or the
 * new one, never a partial write. Reads of a corrupt document throw —
 * external damage must surface, never silently reset into an auto-approval.
 *
 * Contract:
 * - `markReview` is the ONLY way a record enters REVIEW, and it persists
 *   immediately (a crash cannot lose the fact that a shot needs a human).
 * - `approve` / `reject` / `reopen` are the only mutators; each validates
 *   the transition and throws {@link HumanReviewStoreError} on anything
 *   illegal — illegal transitions never touch disk.
 * - `approve` / `reject` REQUIRE a non-empty `decidedBy` (spec §19: the
 *   human REVIEW state exists precisely because approval is a human act) —
 *   the store refuses an anonymous approval outright.
 * - `approve` additionally refuses while the record still carries unresolved
 *   automated-escalation provenance that contradicts the approval? No — the
 *   human is the authority: any REVIEW record may be approved. What the
 *   store refuses is everything else: blank ids, unknown states, anonymous
 *   decisions, corrupt documents.
 * - An in-process write queue serializes concurrent updates; cross-process
 *   callers use `state/locks/` (the recovery service owns that protocol).
 * - `get`/`snapshot`/`listReviews` hand back deep-frozen records — read-only
 *   discipline, mutations go through the mutators only.
 */

import { join } from "node:path";
import { atomicWriteFile, readJsonFileOrNull } from "@mmcs/core/recovery/atomic-write.js";
import type {
  HumanReviewDecisionInput,
  HumanReviewRecord,
  HumanReviewState,
  HumanReviewTrigger,
  ListReviewsQuery,
  MarkReviewInput,
} from "./types.js";
import {
  HUMAN_REVIEW_STATES,
  HUMAN_REVIEW_TRIGGERS,
} from "./types.js";

export const HUMAN_REVIEW_FILE = "human-review.json";

/** Persisted document shape (schemaVersion gates structural changes). */
export const HUMAN_REVIEW_SCHEMA_VERSION = 1 as const;

export interface HumanReviewDocument {
  schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  /** ISO-8601 instant of the last write. */
  updatedAt: string;
  /** shotId -> record, one row per shot that ever entered review. */
  reviews: Record<string, HumanReviewRecord>;
}

/** Thrown on illegal transitions and corrupt documents. */
export class HumanReviewStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanReviewStoreError";
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new HumanReviewStoreError(
      `human-review field "${field}" is not an ISO-8601 timestamp: ${JSON.stringify(value)}`,
    );
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new HumanReviewStoreError(`human-review field "${field}" is required`);
  }
}

/** Validate + normalize a parsed document; throws on structurally unusable data. */
export function normalizeHumanReviewDocument(raw: unknown): HumanReviewDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HumanReviewStoreError("human-review document must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== HUMAN_REVIEW_SCHEMA_VERSION) {
    throw new HumanReviewStoreError(
      `unsupported human-review schemaVersion ${JSON.stringify(doc.schemaVersion)} — expected ${HUMAN_REVIEW_SCHEMA_VERSION}`,
    );
  }
  const reviewsRaw = doc.reviews;
  if (reviewsRaw === null || typeof reviewsRaw !== "object" || Array.isArray(reviewsRaw)) {
    throw new HumanReviewStoreError('human-review document is missing its "reviews" object');
  }
  const updatedAt = typeof doc.updatedAt === "string" ? doc.updatedAt : "";
  assertIsoTimestamp(updatedAt || "missing", "updatedAt");

  // Null-prototype map: a shot literally named "toString"/"__proto__" must
  // never resolve against the Object prototype (reads fabricate records) or
  // be silently swallowed by a plain-object write (entries vanish on reload).
  const reviews: Record<string, HumanReviewRecord> = Object.create(null) as Record<
    string,
    HumanReviewRecord
  >;
  for (const [shotId, entry] of Object.entries(reviewsRaw as Record<string, unknown>)) {
    assertNonEmpty(shotId, "shotId");
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HumanReviewStoreError(`review "${shotId}" is missing its record`);
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.shotId === "string" && rec.shotId !== shotId) {
      throw new HumanReviewStoreError(
        `review record shotId ${JSON.stringify(rec.shotId)} does not match its key ${JSON.stringify(shotId)}`,
      );
    }
    const state = rec.state;
    if (typeof state !== "string" || !(HUMAN_REVIEW_STATES as readonly string[]).includes(state)) {
      throw new HumanReviewStoreError(
        `review "${shotId}" has corrupt state ${JSON.stringify(state)}`,
      );
    }
    const trigger = rec.trigger;
    if (
      typeof trigger !== "string" ||
      !(HUMAN_REVIEW_TRIGGERS as readonly string[]).includes(trigger)
    ) {
      throw new HumanReviewStoreError(
        `review "${shotId}" has corrupt trigger ${JSON.stringify(trigger)}`,
      );
    }
    const asIso = (field: string): string | null => {
      const v = rec[field];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        throw new HumanReviewStoreError(
          `review "${shotId}" field "${field}" must be a string`,
        );
      }
      assertIsoTimestamp(v, `${shotId}.${field}`);
      return v;
    };
    const asText = (field: string): string | null => {
      const v = rec[field];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        throw new HumanReviewStoreError(
          `review "${shotId}" field "${field}" must be a string`,
        );
      }
      return v;
    };
    const asStringArray = (field: string): string[] => {
      const v = rec[field];
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        throw new HumanReviewStoreError(
          `review "${shotId}" field "${field}" must be an array of strings`,
        );
      }
      return v as string[];
    };
    const attempt = rec.attempt;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 0) {
      throw new HumanReviewStoreError(
        `review "${shotId}" field "attempt" must be a non-negative integer`,
      );
    }
    const decidedAt = asIso("decidedAt");
    const decidedBy = asText("decidedBy");
    const record: HumanReviewRecord = {
      shotId,
      episodeId: asText("episodeId") ?? "",
      sceneId: asText("sceneId"),
      attempt,
      trigger: trigger as HumanReviewTrigger,
      reason: asText("reason") ?? "",
      routesTried: asStringArray("routesTried"),
      state: state as HumanReviewState,
      enteredAt: asIso("enteredAt") ?? updatedAt,
      updatedAt: asIso("updatedAt") ?? updatedAt,
      decidedAt,
      decidedBy,
      note: asText("note"),
    };
    // NO SILENT AUTO-APPROVAL, enforced at the data layer: a decided record
    // without the recorded human identity is corrupt — external damage (or a
    // forged document) must surface here, never impersonate an approval.
    if (record.state === "APPROVED" || record.state === "REJECTED") {
      if (record.decidedAt === null || record.decidedBy === null) {
        throw new HumanReviewStoreError(
          `review "${shotId}" is ${record.state} without decidedAt/decidedBy — approvals require a recorded human decision`,
        );
      }
    }
    if (shotId.trim() === "") {
      throw new HumanReviewStoreError('human-review record shotId cannot be blank');
    }
    reviews[shotId] = record;
  }
  return {
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    updatedAt,
    reviews,
  };
}

/** A fresh empty document (null-prototype reviews — see normalize note). */
export function emptyHumanReviewDocument(now: string): HumanReviewDocument {
  return {
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    updatedAt: now,
    reviews: Object.create(null) as Record<string, HumanReviewRecord>,
  };
}

export class HumanReviewStore {
  readonly dir: string;
  readonly filePath: string;
  private cached: HumanReviewDocument | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, opts?: { fileName?: string }) {
    if (!dir || dir.trim() === "") {
      throw new HumanReviewStoreError("human-review store dir is required");
    }
    this.dir = dir;
    this.filePath = join(dir, opts?.fileName ?? HUMAN_REVIEW_FILE);
  }

  /** Current document, loading from disk on first access (missing file = empty). */
  async get(): Promise<HumanReviewDocument> {
    if (this.cached === null) {
      const raw = await readJsonFileOrNull<unknown>(this.filePath);
      this.cached = freezeDocument(
        raw === null ? emptyHumanReviewDocument(new Date().toISOString()) : normalizeHumanReviewDocument(raw),
      );
    }
    return this.cached;
  }

  /** Read-only deep-frozen record for one shot, or null when never reviewed. */
  async snapshot(shotId: string): Promise<HumanReviewRecord | null> {
    assertNonEmpty(shotId, "shotId");
    const doc = await this.get();
    return doc.reviews[shotId] ?? null;
  }

  /**
   * List review records. Default: only undecided REVIEW items (what
   * `mmcs qc` surfaces); `includeResolved: true` adds APPROVED/REJECTED.
   */
  async listReviews(query: ListReviewsQuery = {}): Promise<HumanReviewRecord[]> {
    const doc = await this.get();
    const all = Object.values(doc.reviews);
    const filtered = all.filter((rec) => {
      if (query.episodeId !== undefined && rec.episodeId !== query.episodeId) return false;
      if (query.includeResolved !== true && rec.state !== "REVIEW") return false;
      return true;
    });
    // Oldest entry first — the longest-parked shots surface first.
    return filtered.sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt));
  }

  /** Count of currently-open (undecided REVIEW) records, optionally per episode. */
  async openCount(episodeId?: string): Promise<number> {
    const doc = await this.get();
    return Object.values(doc.reviews).filter(
      (rec) =>
        rec.state === "REVIEW" &&
        (episodeId === undefined || rec.episodeId === episodeId),
    ).length;
  }

  /**
   * Enter (or refresh) the human REVIEW state for one shot. This is the
   * persistence boundary the pipeline calls when an exhaustion trigger fires;
   * the record is on disk before the promise resolves.
   */
  async markReview(input: MarkReviewInput): Promise<HumanReviewRecord> {
    assertNonEmpty(input.shotId, "shotId");
    assertNonEmpty(input.episodeId, "episodeId");
    assertNonEmpty(input.reason, "reason");
    if (!(HUMAN_REVIEW_TRIGGERS as readonly string[]).includes(input.trigger)) {
      throw new HumanReviewStoreError(
        `unknown human-review trigger ${JSON.stringify(input.trigger)} (known: ${HUMAN_REVIEW_TRIGGERS.join(", ")})`,
      );
    }
    const now = input.now ?? new Date().toISOString();
    assertIsoTimestamp(now, "now");
    const run = async (): Promise<HumanReviewRecord> => {
      const doc = await this.get();
      const existing = doc.reviews[input.shotId];
      // Refresh semantics: re-entering REVIEW (after a fix attempt failed
      // again) updates the evidence but PRESERVES the original enteredAt —
      // "parked since when" must not reset on every failed retry.
      const record: HumanReviewRecord = {
        shotId: input.shotId,
        episodeId: input.episodeId,
        sceneId: input.sceneId ?? existing?.sceneId ?? null,
        attempt: input.attempt ?? existing?.attempt ?? 0,
        trigger: input.trigger,
        reason: input.reason,
        routesTried: [...(input.routesTried ?? existing?.routesTried ?? [])],
        state: "REVIEW",
        enteredAt: existing?.enteredAt ?? now,
        updatedAt: now,
        // A human re-opening or re-entering review clears the prior decision:
        // the shot is undecided again. decidedBy/decidedAt are cleared WITH
        // the state (no stale approval-looking fields on a REVIEW row).
        decidedAt: null,
        decidedBy: null,
        note: existing?.note ?? null,
      };
      await this.persist({
        schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
        updatedAt: now,
        reviews: { ...doc.reviews, [input.shotId]: record },
      });
      return record;
    };
    return this.enqueue(run);
  }

  /** Approve a REVIEW record — human decision REQUIRED. */
  async approve(shotId: string, decision: HumanReviewDecisionInput): Promise<HumanReviewRecord> {
    return this.applyDecision(shotId, "APPROVED", decision);
  }

  /** Reject a REVIEW record — sends the work back for regeneration planning. */
  async reject(shotId: string, decision: HumanReviewDecisionInput): Promise<HumanReviewRecord> {
    return this.applyDecision(shotId, "REJECTED", decision);
  }

  /** Reopen a decided record back to REVIEW (fix attempt failed again, new evidence). */
  async reopen(shotId: string, decision: HumanReviewDecisionInput = {}): Promise<HumanReviewRecord> {
    return this.applyDecision(shotId, "REVIEW", decision);
  }

  /** Apply one decision after validating it; illegal transitions throw, disk untouched. */
  private async applyDecision(
    shotId: string,
    to: HumanReviewState,
    decision: HumanReviewDecisionInput,
  ): Promise<HumanReviewRecord> {
    assertNonEmpty(shotId, "shotId");
    const now = decision.now ?? new Date().toISOString();
    assertIsoTimestamp(now, "now");
    const run = async (): Promise<HumanReviewRecord> => {
      const doc = await this.get();
      const current = doc.reviews[shotId];
      if (current === undefined) {
        throw new HumanReviewStoreError(
          `no human-review record for shot ${JSON.stringify(shotId)} — enter REVIEW with markReview first`,
        );
      }
      const from = current.state;
      requireLegalTransition(from, to, shotId);
      const deciding = to === "APPROVED" || to === "REJECTED";
      // NO SILENT AUTO-APPROVAL: an anonymous decision is refused before it
      // can reach disk. Trim, don't guess — whitespace is not a human.
      const human = deciding ? decision.decidedBy?.trim() ?? "" : undefined;
      if (deciding && (human === undefined || human === "")) {
        throw new HumanReviewStoreError(
          `${to} on shot ${JSON.stringify(shotId)} requires decidedBy — the human REVIEW state can only be resolved by a recorded human decision`,
        );
      }
      const record: HumanReviewRecord = {
        ...current,
        state: to,
        // Decision fields clear together with the state on reopen — a REVIEW
        // row never carries stale approval-looking fields.
        decidedAt: deciding ? now : null,
        decidedBy: deciding ? (human as string) : (decision.decidedBy?.trim() || null),
        note: decision.note?.trim() ? decision.note.trim() : current.note,
        updatedAt: now,
      };
      await this.persist({
        schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
        updatedAt: now,
        reviews: { ...doc.reviews, [shotId]: record },
      });
      return record;
    };
    return this.enqueue(run);
  }

  /** Serialize concurrent updates in-process (cross-process uses state/locks/). */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  /** Persist the full document atomically and cache it. */
  private async persist(doc: HumanReviewDocument): Promise<void> {
    // Rebuild the reviews container with a null prototype before caching:
    // callers mutate via spread into plain literals, and a cached
    // Object.prototype-backed map would let `reviews["toString"]` fabricate
    // a record from the inherited method (see normalizeHumanReviewDocument).
    const cached: HumanReviewDocument = {
      schemaVersion: doc.schemaVersion,
      updatedAt: doc.updatedAt,
      reviews: Object.assign(Object.create(null) as Record<string, HumanReviewRecord>, doc.reviews),
    };
    const serialized = `${JSON.stringify(cached, null, 2)}\n`;
    await atomicWriteFile(this.filePath, serialized);
    this.cached = freezeDocument(cached);
  }
}

/**
 * Legal state transitions (spec §3 discipline — validate, never guess):
 * REVIEW → APPROVED | REJECTED (human decides); APPROVED/REJECTED → REVIEW
 * (reopen with new evidence). A decided state can never jump to the other
 * decided state — the prior decision must be reopened explicitly.
 */
export const LEGAL_HUMAN_REVIEW_TRANSITIONS: Readonly<
  Record<HumanReviewState, readonly HumanReviewState[]>
> = {
  REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["REVIEW"],
  REJECTED: ["REVIEW"],
};

function requireLegalTransition(from: HumanReviewState, to: HumanReviewState, shotId: string): void {
  if (!(LEGAL_HUMAN_REVIEW_TRANSITIONS[from] ?? []).includes(to)) {
    throw new HumanReviewStoreError(
      `illegal human-review transition ${from} → ${to} for shot ${JSON.stringify(shotId)}`,
    );
  }
}

/** Deep-freeze a document so consumers cannot corrupt store state by reference. */
function freezeDocument(doc: HumanReviewDocument): HumanReviewDocument {
  for (const record of Object.values(doc.reviews)) {
    Object.freeze(record);
    Object.freeze(record.routesTried);
  }
  Object.freeze(doc.reviews);
  return Object.freeze(doc);
}
