/// <reference types="node" />
/**
 * AGN-005 — Agnes video poll + resume types.
 *
 * Job-safety contract (spec §18 / runbook): the provider task/job ID is
 * persisted BEFORE any polling begins. Restart at SUBMITTED (or GENERATING)
 * resumes polling the existing job — never resubmits, never double-spends.
 * This module is POLL-ONLY: it never calls a submit/create endpoint. Submit
 * is AGN-004's job; this module takes over once a record is persisted.
 *
 * Verified provider facts (2026-08-28, docs/provider-capabilities/agnes.md):
 * - Retrieval: `GET /agnesapi?video_id=…&model_name=…` (model_name required
 *   for keyframe/reference tasks; bare video_id valid for mode:"text").
 * - Status enum: `queued` | `in_progress` | `completed` | `failed`.
 * - Output URL: `metadata.url` (present when status is `completed`).
 * - No expiration field is documented on any Agnes page → URL expiration is
 *   never invented; it stays `null` (UNKNOWN) unless the provider returns one.
 */

/** Full pipeline job-state machine (spec §18). */
export type AgnesPipelineState =
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

/**
 * States the poll loop treats as terminal. ARCHIVING/ARCHIVED/QC_* are owned
 * by the archival and QC layers downstream (spec §17, §18).
 */
export const AGNES_POLL_TERMINAL_STATES: ReadonlySet<AgnesPipelineState> = new Set([
  "GENERATED_TEMPORARY",
  "REJECTED",
]);

/** True when a poll loop may stop at this state. */
export function isAgnesPollTerminal(state: AgnesPipelineState): boolean {
  return AGNES_POLL_TERMINAL_STATES.has(state);
}

/**
 * Normalized Agnes task status. Agnes' documented raw strings (queued,
 * in_progress, completed, failed) fold into these four via
 * {@link normalizeAgnesStatus}.
 */
export type AgnesTaskStatus = "waiting" | "running" | "success" | "failed";

/**
 * Raw task-info payload from `GET /agnesapi?video_id=…&model_name=…`
 * (field names verified 2026-08-28 against the Agnes Video 2.5 docs).
 */
export interface AgnesVideoTaskInfo {
  /** Task ID; same as `task_id` on the retrieved payload. */
  id?: string;
  /** Video ID used to retrieve the task. */
  video_id?: string;
  /** Async generation task ID. */
  task_id?: string;
  /** Always "video". */
  object?: string;
  /** Model used. */
  model?: string;
  /** Raw provider status string: queued | in_progress | completed | failed. */
  status: string;
  /** 0–100 progress. */
  progress?: number;
  /** Unix seconds. */
  created_at?: number;
  /** Unix seconds; null before completion. */
  completed_at?: number | null;
  /** Output duration in seconds (string). */
  seconds?: string;
  /** "720P" | "960P" | "2K". */
  size?: string;
  /** Result payload; empty (null) before completion. `metadata.url` holds the
   *  temporary output URL. Free-form so unknown future fields are preserved. */
  metadata?: Record<string, unknown> | null;
  /** Failure detail. */
  error?: { message?: string; code?: number } | null;
  /**
   * Provider-declared URL expiration passthroughs. Agnes documents none
   * today (verified 2026-08-28); these fields exist so a provider-added
   * expiration is captured the moment it appears, never invented.
   */
  urlExpiration?: string;
  expiresAt?: string | number;
}

/** Normalized failure detail carried on a REJECTED record. */
export interface AgnesVideoFailure {
  message: string;
  code?: number;
  /** Raw provider payload preserved for failure normalization. */
  raw?: unknown;
}

/**
 * Durable record for one Agnes video job. Persisted by AGN-004 BEFORE
 * polling (spec §18); the poll runner reads it and never creates a job.
 *
 * SEAM COMPATIBILITY (AGN-004 → AGN-005): AGN-004 persists the same durable
 * record under its own field names — `providerJobId` (the Agnes `video_id`),
 * `resultUrls` (string array), `lastPolledAt`, `requestHash`, `provider`.
 * This interface is a superset of that persisted shape so a record written
 * by the submit layer polls and resumes WITHOUT any adapter: every
 * AGN-004-authored field below is optional here, and the runner resolves
 * retrieval keys and result URLs across both namings. AGN-004's types are
 * not importable from this worktree (task branched pre-merge), so the
 * compatible fields are declared explicitly; keep them in sync with
 * `AgnesVideoJobRecord` at merge time.
 */
export interface AgnesVideoTaskRecord {
  /** Business reference (e.g. "shot-42:keyframe-a"). Unique per store. */
  ref: string;
  /** Current pipeline state (spec §18 machine). */
  state: AgnesPipelineState;
  /**
   * Provider task ID. The load-bearing idempotency invariant: persisted
   * before any poll; resume-at-SUBMITTED polls this instead of resubmitting.
   */
  providerTaskId?: string;
  /**
   * Agnes retrieval key (`video_id` from the create response). Preferred
   * retrieval parameter; falls back to {@link providerTaskId} when absent.
   */
  videoId?: string;
  /**
   * AGN-004's persisted name for the provider job ID (the Agnes `video_id`).
   * Cross-seam alias of {@link videoId}: a record written by the submit
   * layer carries THIS field, so the runner resolves it as the retrieval
   * key. Without it, resume-at-SUBMITTED would see "no key" and dead-end.
   */
  providerJobId?: string;
  /** Provider model identifier; passed as `model_name` on retrieval. */
  model?: string;
  /** Submit payload kept for audit/manual re-check (written by AGN-004). */
  submitRequest?: unknown;
  /** AGN-004 idempotency hash (CORE-013 `requestHash`); preserved untouched. */
  requestHash?: string;
  /** Provider family (AGN-004 persists `"agnes"`); preserved untouched. */
  provider?: string;
  /** Temporary provider result URL captured on GENERATED_TEMPORARY. */
  resultUrl?: string;
  /**
   * AGN-004-declared array of temporary provider result URLs ("owned by
   * AGN-005/AGN-008"). The runner appends each captured URL here so
   * downstream archival/validation layers read the field AGN-004 promised.
   */
  resultUrls?: string[];
  /**
   * ISO-8601 last poll timestamp. AGN-004 declares this "owned by AGN-005";
   * the runner writes it on every poll.
   */
  lastPolledAt?: string;
  /**
   * Expiration of {@link resultUrl}, ISO-8601, when the provider returns one.
   * NEVER invented: absent/undocumented → `null` (UNKNOWN per runbook §25).
   */
  urlExpiration?: string | null;
  /** Failure detail when state is REJECTED. */
  failure?: AgnesVideoFailure;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** How many polls have been recorded (diagnostics). */
  pollCount?: number;
}

/** Durable store port for Agnes task records. Implement over SQLite (CORE-007). */
export interface AgnesVideoTaskStore {
  /** Load the record for `ref`, or undefined when absent. */
  load(ref: string): Promise<AgnesVideoTaskRecord | undefined>;
  /** Upsert the record for `ref`. */
  save(record: AgnesVideoTaskRecord): Promise<void>;
}

/**
 * Poll-only transport port over Agnes' retrieval endpoint. AGN-001 (client/
 * auth) owns the shared HTTP client and adapts to this port.
 */
export interface AgnesVideoClient {
  /**
   * Poll one task by its retrieval key. `modelName` is sent as
   * `model_name` when present (required by Agnes for keyframe/reference
   * tasks; bare `video_id` is valid only for mode:"text").
   */
  getTask(retrievalKey: string, modelName?: string): Promise<AgnesVideoTaskInfo>;
}

/** Options for {@link AgnesVideoPollRunner}. */
export interface AgnesPollRunnerOptions {
  /** Injectable clock (ISO string); defaults to Date.now-based. */
  now?: () => string;
  /** Injectable sleep; defaults to a setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for the bounded poll loop (poll-only: no request parameter). */
export interface AgnesPollRunOptions {
  /** Delay between polls in ms. Default 5000. */
  intervalMs?: number;
  /** Overall deadline in ms. Default 600000 (10 min). */
  timeoutMs?: number;
}
