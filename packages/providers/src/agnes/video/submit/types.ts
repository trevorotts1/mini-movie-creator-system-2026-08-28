/**
 * AGN-004 — Agnes video job submit types.
 *
 * State machine per spec §18 (async provider job safety). This module drives
 * only the submit subset (PLANNED → BUDGET_RESERVED → SUBMITTING → SUBMITTED);
 * GENERATING onward is owned by AGN-005 (poll + resume), ARCHIVING/ARCHIVED/
 * QC_* by the archival and QC layers downstream.
 *
 * Binding invariant (spec §18): the provider job ID is persisted BEFORE any
 * polling happens. This module never polls — it only submits and persists —
 * so the invariant holds structurally: `providerJobId` is undefined until the
 * SUBMITTED save, and AGN-005's poller refuses to poll without it.
 */

import type { AgnesVideoSubmitRequest } from "./request.js";

/**
 * Full pipeline job-state machine (spec §18). Mirrors the KIE-002 machine —
 * one §18 machine, provider-specific record types.
 */
export type AgnesVideoJobState =
  | "PLANNED"
  | "BUDGET_RESERVED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "GENERATING"
  | "GENERATED_TEMPORARY"
  | "ARCHIVING"
  | "ARCHIVED"
  | "QC_PENDING"
  | "QC_FIXING"
  | "APPROVED"
  | "REJECTED";

/** The two Agnes video models MMCS seeds (CAP-002, spec §26.1/§26.2). */
export type AgnesVideoModelId = "agnes-video-2.5-flash" | "agnes-video-2.5";

/** Agnes Video 2.5 generation modes (docs: mode `text` | `keyframe` | `reference`). */
export type AgnesVideoMode = "text" | "keyframe" | "reference";

/**
 * Durable archival status carried on the job record (spec §17/§18).
 * "PENDING" from submit until the archival layer (GHL MediaStore) takes over.
 */
export type AgnesVideoArchivalStatus =
  | "PENDING"
  | "ARCHIVING"
  | "ARCHIVED"
  | "FAILED";

/**
 * Durable record for one Agnes video job (spec §18 required fields). Persisted
 * BEFORE polling; a restart at SUBMITTED resumes polling this record's
 * `providerJobId` and never resubmits.
 */
export interface AgnesVideoJobRecord {
  /** Business reference (e.g. "S01E03:SC04:SH07"). Unique per store. */
  ref: string;
  /** Current pipeline state (spec §18 machine). */
  state: AgnesVideoJobState;
  /**
   * Stable sha-256 request hash (CORE-013 `requestHash`) over the canonical
   * submit request — the idempotency identifier where the provider supports
   * none (Agnes documents none). Same request ⇒ same hash ⇒ same job.
   */
  requestHash: string;
  /** Provider family; fixed "agnes". */
  provider: "agnes";
  /** Provider model identifier the job was submitted with. */
  model: AgnesVideoModelId;
  /**
   * Provider job ID (Agnes `video_id`). THE load-bearing idempotency
   * invariant: written before any poll, and resume-at-SUBMITTED polls it
   * instead of resubmitting (never double-spend, spec §18).
   */
  providerJobId?: string;
  /** Exact request payload kept for audit/manual re-check (spec §18). */
  submitRequest?: AgnesVideoSubmitRequest;
  /** Exact prompt character count recorded pre-request (spec §5 chain). */
  promptCharacterCount?: number;
  /** Estimated cost from the budget stage (spec §4: derive cost BEFORE spend). */
  estimatedCostUsd?: number;
  /** ISO-8601 submission timestamp. */
  submittedAt?: string;
  /** ISO-8601 last poll timestamp. Owned by AGN-005. */
  lastPolledAt?: string;
  /** Temporary provider result URLs. Owned by AGN-005/AGN-008. */
  resultUrls?: string[];
  /** Durable archival status (spec §17). Starts PENDING. */
  archivalStatus?: AgnesVideoArchivalStatus;
  /** Retry count. Owned by AGN-010 (bounded retry). */
  retryCount?: number;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Durable store port for Agnes video job records. Implement over SQLite
 * (CORE-007 schema band); the submitter depends only on this port, so tests
 * run against an in-memory store and the PostgreSQL migration later stays
 * practical (spec §25).
 */
export interface AgnesVideoJobStore {
  /** Load the record for `ref`, or undefined when absent. */
  load(ref: string): Promise<AgnesVideoJobRecord | undefined>;
  /** Upsert the record for `ref`. */
  save(record: AgnesVideoJobRecord): Promise<void>;
}

/**
 * Transport-level client port over Agnes's video endpoints (AGN-001 owns the
 * shared HTTP client; it adapts to this port). The submitter depends only on
 * this interface — no fetch, no key handling here (keys never enter this
 * module, so they can never be logged by it).
 *
 * There is deliberately NO poll method on this port: submitting must not be
 * able to poll. AGN-005 defines its own retrieve port keyed off the persisted
 * `providerJobId`.
 */
export interface AgnesVideoClient {
  /** Submit one video job; resolves with the provider job ID (video_id). */
  createVideo(
    request: AgnesVideoSubmitRequest,
  ): Promise<{ videoId: string; raw?: unknown }>;
}

/** Payload passed to the budget gate (spec §4 cumulative atomic reservation). */
export interface AgnesVideoBudgetReservationRequest {
  ref: string;
  provider: "agnes";
  model: AgnesVideoModelId;
  /** Estimated paid spend this job may incur, USD. */
  estimatedCostUsd: number;
  currency: "USD";
}

/** A held budget reservation. Release on failure; hold through success. */
export interface AgnesVideoBudgetReservation {
  readonly id: string;
  /** Release the held amount. "failed" when submission did not land. */
  release(reason: "submitted" | "failed"): Promise<void>;
}

/**
 * Budget gate port (spec §4/§5 final chain stage: reservation precedes
 * submission, state BUDGET_RESERVED). CORE-009's atomic ledger provides the
 * production implementation; tests supply a scripted gate. The submitter
 * never computes spend authority itself.
 */
export interface AgnesVideoBudgetGate {
  reserve(
    request: AgnesVideoBudgetReservationRequest,
  ): Promise<AgnesVideoBudgetReservation>;
}

/** Options for {@link AgnesVideoSubmitter}. */
export interface AgnesVideoSubmitterOptions {
  /** Injectable clock (ISO string); defaults to Date-based. */
  now?: () => string;
  /**
   * Structured logger (CORE-012). Defaults to a component-scoped logger.
   * The submitter logs only non-secret fields — never keys, never full
   * prompts of untrusted story data beyond length/count metadata.
   */
  logger?: import("@mmcs/core/logging/index.js").Logger;
}