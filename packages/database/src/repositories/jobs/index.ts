import type { SqlValue } from "../../connection/index.js";
import { BaseRepository, type CrudRepository } from "../base.js";
import {
  ARCHIVAL_STATUSES,
  JOB_STATES,
  isLegalJobTransition,
  type ArchivalStatus,
  type ProviderJobState,
} from "./job-states.js";

/**
 * Durable provider-job record (spec §18): the row is written BEFORE the
 * provider task is polled, so a restart at SUBMITTED resumes polling the
 * existing job and a restart at GENERATED_TEMPORARY archives the known
 * provider URL — never resubmit, never double-spend.
 *
 * `requestParams`, `referencesUsed` and `generationSettings` travel as
 * JSON strings in SQLite; repositories serialize/deserialize at the edge
 * so domain types carry plain objects (PostgreSQL `jsonb` later, §25).
 */
export interface ProviderJob {
  readonly id: string;
  /** Request hash / idempotency identifier where the provider supports one. */
  readonly requestHash: string;
  readonly idempotencyKey?: string;
  readonly provider: string;
  readonly providerModel: string;
  readonly providerTaskId?: string;
  readonly requestParams: Record<string, unknown>;
  readonly submittedAt?: string;
  readonly status: ProviderJobState;
  readonly polledAt?: string;
  readonly resultUrl?: string;
  readonly archivalStatus: ArchivalStatus;
  readonly retryCount: number;
  readonly estimatedCostUsd?: number;
  readonly actualCostUsd?: number;
  readonly budgetReservedAt?: string;
  readonly budgetReleasedAt?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderJobPatch = Partial<
  Pick<
    ProviderJob,
    | "idempotencyKey"
    | "providerTaskId"
    | "requestParams"
    | "submittedAt"
    | "status"
    | "polledAt"
    | "resultUrl"
    | "archivalStatus"
    | "retryCount"
    | "estimatedCostUsd"
    | "actualCostUsd"
    | "budgetReservedAt"
    | "budgetReleasedAt"
    | "failureReason"
  >
>;

/** Input for creating a job: the caller supplies everything except defaults. */
export type ProviderJobInput = Omit<ProviderJob, "status" | "archivalStatus" | "retryCount" | "updatedAt"> &
  Partial<Pick<ProviderJob, "status" | "archivalStatus" | "retryCount">>;

export class JobStateTransitionError extends Error {
  readonly from: ProviderJobState;
  readonly to: ProviderJobState;

  constructor(from: ProviderJobState, to: ProviderJobState) {
    super(`illegal provider-job state transition ${from} -> ${to} (spec §18)`);
    this.name = "JobStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

const JOB_COLUMNS = [
  "id",
  "request_hash",
  "idempotency_key",
  "provider",
  "provider_model",
  "provider_task_id",
  "request_params",
  "submitted_at",
  "status",
  "polled_at",
  "result_url",
  "archival_status",
  "retry_count",
  "estimated_cost_usd",
  "actual_cost_usd",
  "budget_reserved_at",
  "budget_released_at",
  "failure_reason",
  "created_at",
  "updated_at",
] as const;

export class ProviderJobRepository extends BaseRepository implements CrudRepository<string, ProviderJob, ProviderJobPatch> {
  readonly name = "provider-jobs";

  /** Create the durable record BEFORE submission/polling (spec §18). */
  create(entity: ProviderJobInput): ProviderJob {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_jobs (
           id, request_hash, idempotency_key, provider, provider_model, provider_task_id,
           request_params, submitted_at, status, polled_at, result_url, archival_status,
           retry_count, estimated_cost_usd, actual_cost_usd, budget_reserved_at,
           budget_released_at, failure_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.requestHash,
        entity.idempotencyKey ?? null,
        entity.provider,
        entity.providerModel,
        entity.providerTaskId ?? null,
        JSON.stringify(entity.requestParams),
        entity.submittedAt ?? null,
        entity.status ?? "PLANNED",
        entity.polledAt ?? null,
        entity.resultUrl ?? null,
        entity.archivalStatus ?? "PENDING",
        entity.retryCount ?? 0,
        entity.estimatedCostUsd ?? null,
        entity.actualCostUsd ?? null,
        entity.budgetReservedAt ?? null,
        entity.budgetReleasedAt ?? null,
        entity.failureReason ?? null,
        entity.createdAt,
        now,
      );
    return this.findById(entity.id) as ProviderJob;
  }

  findById(id: string): ProviderJob | undefined {
    return this.mapRow<Record<string, SqlValue>, ProviderJob>(
      this.db.get(`SELECT ${JOB_COLUMNS.join(", ")} FROM provider_jobs WHERE id = ?`, id),
      mapJobRow,
    );
  }

  update(id: string, patch: ProviderJobPatch): ProviderJob | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (!JOB_STATES.includes(patch.status)) {
        throw new Error(`unknown provider-job status "${String(patch.status)}"`);
      }
      if (!isLegalJobTransition(existing.status, patch.status)) {
        throw new JobStateTransitionError(existing.status, patch.status);
      }
    }
    if (patch.archivalStatus !== undefined && !ARCHIVAL_STATUSES.includes(patch.archivalStatus)) {
      throw new Error(`unknown archival status "${String(patch.archivalStatus)}"`);
    }

    const next = { ...existing, ...patch } as ProviderJob;
    this.db
      .prepare(
        `UPDATE provider_jobs SET
           idempotency_key = ?, provider_task_id = ?, request_params = ?, submitted_at = ?,
           status = ?, polled_at = ?, result_url = ?, archival_status = ?, retry_count = ?,
           estimated_cost_usd = ?, actual_cost_usd = ?, budget_reserved_at = ?,
           budget_released_at = ?, failure_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.idempotencyKey ?? null,
        next.providerTaskId ?? null,
        JSON.stringify(next.requestParams),
        next.submittedAt ?? null,
        next.status,
        next.polledAt ?? null,
        next.resultUrl ?? null,
        next.archivalStatus,
        next.retryCount,
        next.estimatedCostUsd ?? null,
        next.actualCostUsd ?? null,
        next.budgetReservedAt ?? null,
        next.budgetReleasedAt ?? null,
        next.failureReason ?? null,
        new Date().toISOString(),
        id,
      );
    return this.findById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM provider_jobs WHERE id = ?").run(id).changes) > 0;
  }

  list(): ProviderJob[] {
    return this.db
      .all(`SELECT ${JOB_COLUMNS.join(", ")} FROM provider_jobs ORDER BY created_at, id`)
      .map(mapJobRow);
  }

  /**
   * Restart-safety lookup (spec §18): find the durable job for a provider
   * task id so polling resumes on the SAME record, never a resubmission.
   */
  findByProviderTask(provider: string, providerTaskId: string): ProviderJob | undefined {
    return this.mapRow<Record<string, SqlValue>, ProviderJob>(
      this.db.get(
        `SELECT ${JOB_COLUMNS.join(", ")} FROM provider_jobs WHERE provider = ? AND provider_task_id = ?`,
        provider,
        providerTaskId,
      ),
      mapJobRow,
    );
  }

  /** Idempotent-submit lookup: one job per (provider, idempotency key). */
  findByIdempotencyKey(provider: string, idempotencyKey: string): ProviderJob | undefined {
    return this.mapRow<Record<string, SqlValue>, ProviderJob>(
      this.db.get(
        `SELECT ${JOB_COLUMNS.join(", ")} FROM provider_jobs WHERE provider = ? AND idempotency_key = ?`,
        provider,
        idempotencyKey,
      ),
      mapJobRow,
    );
  }

  /** All jobs currently in one of the given states (poller worklist). */
  listByStatus(statuses: readonly ProviderJobState[]): ProviderJob[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .all(
        `SELECT ${JOB_COLUMNS.join(", ")} FROM provider_jobs WHERE status IN (${placeholders}) ORDER BY created_at, id`,
        ...statuses,
      )
      .map(mapJobRow);
  }
}

function mapJobRow(row: Record<string, SqlValue>): ProviderJob {
  return {
    id: String(row["id"]),
    requestHash: String(row["request_hash"]),
    idempotencyKey: row["idempotency_key"] === null ? undefined : String(row["idempotency_key"]),
    provider: String(row["provider"]),
    providerModel: String(row["provider_model"]),
    providerTaskId: row["provider_task_id"] === null ? undefined : String(row["provider_task_id"]),
    requestParams: JSON.parse(String(row["request_params"] ?? "{}")) as Record<string, unknown>,
    submittedAt: row["submitted_at"] === null ? undefined : String(row["submitted_at"]),
    status: String(row["status"]) as ProviderJobState,
    polledAt: row["polled_at"] === null ? undefined : String(row["polled_at"]),
    resultUrl: row["result_url"] === null ? undefined : String(row["result_url"]),
    archivalStatus: String(row["archival_status"]) as ArchivalStatus,
    retryCount: Number(row["retry_count"] ?? 0),
    estimatedCostUsd: row["estimated_cost_usd"] === null ? undefined : Number(row["estimated_cost_usd"]),
    actualCostUsd: row["actual_cost_usd"] === null ? undefined : Number(row["actual_cost_usd"]),
    budgetReservedAt: row["budget_reserved_at"] === null ? undefined : String(row["budget_reserved_at"]),
    budgetReleasedAt: row["budget_released_at"] === null ? undefined : String(row["budget_released_at"]),
    failureReason: row["failure_reason"] === null ? undefined : String(row["failure_reason"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}