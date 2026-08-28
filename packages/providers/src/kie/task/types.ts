/**
 * KIE-002 — generic Kie task submit/poll types.
 *
 * State machine per runbook §21 (pipeline job states). This module drives only
 * the submit/poll subset (SUBMITTING → SUBMITTED → GENERATING →
 * GENERATED_TEMPORARY / REJECTED); ARCHIVING/ARCHIVED/QC_* are owned by the
 * archival and QC layers downstream.
 */

/** Full pipeline job-state machine (runbook §21). */
export type KiePipelineState =
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
 * States the generic poll loop treats as terminal. Later layers (KIE-008
 * archival, QC) own everything after GENERATED_TEMPORARY.
 */
export const POLL_TERMINAL_STATES: ReadonlySet<KiePipelineState> = new Set([
  "GENERATED_TEMPORARY",
  "REJECTED",
]);

/** True when a poll loop may stop at this state. */
export function isPollTerminal(state: KiePipelineState): boolean {
  return POLL_TERMINAL_STATES.has(state);
}

/**
 * Normalized Kie task status. Kie's raw API strings (waiting/queued/…,
 * success/fail) are folded into these four via {@link normalizeKieStatus}.
 */
export type KieTaskStatus = "waiting" | "running" | "success" | "failed";

/** Request body for Kie's createTask endpoint (model-profile agnostic). */
export interface KieCreateTaskRequest {
  /** Provider model identifier, e.g. the Seedance/Wan model slug. */
  model: string;
  /** Model-specific input payload; profiles (KIE-003/004/005) own its shape. */
  input: Record<string, unknown>;
  /** Optional provider callback URL. */
  callBackUrl?: string;
}

/** Response for Kie's createTask endpoint. */
export interface KieCreateTaskResponse {
  /** Provider task ID. MUST be persisted before any polling happens. */
  taskId: string;
}

/** Raw task-info payload from Kie's getTaskInfo endpoint. */
export interface KieTaskInfo {
  taskId: string;
  /** Raw provider status string as returned by the API (e.g. "waiting"). */
  state: string;
  /** Raw provider result payload; parsed by {@link parseResultUrls}. */
  result?: unknown;
  /** Provider failure message (when state indicates failure). */
  failMsg?: string;
  /** Provider failure code (when state indicates failure). */
  failCode?: number;
}

/**
 * Transport-level client port over Kie's task endpoints. KIE-001 (client/auth)
 * owns the shared HTTP client; adapters may adapt to this port. The generic
 * runner depends only on this interface.
 */
export interface KieTaskClient {
  createTask(request: KieCreateTaskRequest): Promise<KieCreateTaskResponse>;
  getTask(taskId: string): Promise<KieTaskInfo>;
}

/** Normalized failure detail carried on a REJECTED record. */
export interface KieTaskFailure {
  message: string;
  code?: number;
  /** Raw provider payload preserved for KIE-009 failure normalization. */
  raw?: unknown;
}

/** Durable record for one provider job. Persisted BEFORE polling. */
export interface KieTaskRecord {
  /** Business reference (e.g. "shot-42:keyframe-a"). Unique per store. */
  ref: string;
  /** Current pipeline state (runbook §21 machine). */
  state: KiePipelineState;
  /**
   * Provider task ID. The load-bearing idempotency invariant: this is written
   * before any poll, and resume-at-SUBMITTED polls it instead of resubmitting.
   */
  providerTaskId?: string;
  /** Provider model identifier the job was submitted with. */
  model?: string;
  /** Submit payload kept for audit/manual re-check. */
  submitRequest?: KieCreateTaskRequest;
  /** Provider result URLs (temporary) captured on success. */
  resultUrls?: string[];
  /** Failure detail when state is REJECTED. */
  failure?: KieTaskFailure;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** How many polls have been recorded (diagnostics). */
  pollCount?: number;
}

/** Durable store port for Kie task records. Implement over SQLite (CORE-007). */
export interface KieTaskStore {
  /** Load the record for `ref`, or undefined when absent. */
  load(ref: string): Promise<KieTaskRecord | undefined>;
  /** Upsert the record for `ref`. */
  save(record: KieTaskRecord): Promise<void>;
}

/** Options for {@link KieTaskRunner}. */
export interface KieTaskRunnerOptions {
  /** Injectable clock (ISO string); defaults to Date.now-based. */
  now?: () => string;
  /** Injectable sleep; defaults to a setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for the bounded poll loop. */
export interface KieRunToTerminalOptions {
  /** Delay between polls in ms. Default 5000. */
  intervalMs?: number;
  /** Overall deadline in ms. Default 600000 (10 min). */
  timeoutMs?: number;
}