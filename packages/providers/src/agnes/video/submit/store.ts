/**
 * AGN-004 — SQLite-backed AgnesVideoJobStore over the CORE-007 provider-jobs
 * schema band.
 *
 * The durable record (spec §18: provider/model, task/job ID, request params,
 * submission timestamp, status, poll timestamp, result URL, archival status,
 * retry count) lives in the `provider_jobs` table created by the 040_ band
 * (CORE-007). This store maps between the domain record and that table's
 * JSON payload column, keeping SQL shapes at the edge (spec §25).
 *
 * Schema evolution note: CORE-007's band owns the canonical DDL. Until that
 * band merges, {@link AgnesVideoJobStoreSqlite} self-heals its table with
 * `CREATE TABLE IF NOT EXISTS` using the agreed shape, so an integration
 * merge order gap cannot break the submit path.
 */

import type { SqliteDatabase } from "@mmcs/database/index.js";

import type {
  AgnesVideoArchivalStatus,
  AgnesVideoJobRecord,
  AgnesVideoJobState,
  AgnesVideoJobStore,
} from "./types.js";

/**
 * The 040_ band owns `provider_jobs`; this store must NOT create its own shape.
 *
 * It previously self-healed a ref-keyed 7-column table here. That was the
 * drift: the migration creates `id`-keyed, 20-column, STRICT, with CHECK enums,
 * so whichever side ran first broke the other — migration-first made this
 * store's `INSERT (ref, ...)` fail with "table provider_jobs has no column
 * named ref". The self-heal is gone; the store now speaks the canonical schema
 * and fails loudly if the database has not been migrated.
 */
const REQUIRED_COLUMNS = [
  "id",
  "request_hash",
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
  "created_at",
  "updated_at",
] as const;

/**
 * Archival status is the one enum the two sides disagree on: the canonical
 * CHECK allows IN_PROGRESS/SKIPPED, the Agnes domain says ARCHIVING. Map at the
 * boundary so a stored ARCHIVING cannot violate the constraint.
 */
function toCanonicalArchival(status: AgnesVideoArchivalStatus | undefined): string {
  if (status === "ARCHIVING") return "IN_PROGRESS";
  return status ?? "PENDING";
}

function fromCanonicalArchival(status: string): AgnesVideoArchivalStatus {
  if (status === "IN_PROGRESS") return "ARCHIVING";
  // SKIPPED exists canonically but is never produced by the Agnes path.
  if (status === "SKIPPED") return "PENDING";
  return status as AgnesVideoArchivalStatus;
}

/** Numeric shape of one canonical `provider_jobs` row. */
interface ProviderJobRow {
  id: string;
  provider: string;
  provider_model: string;
  provider_task_id: string | null;
  status: string;
  request_params: string;
  submitted_at: string | null;
  polled_at: string | null;
  result_url: string | null;
  archival_status: string;
  retry_count: number;
  estimated_cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

/** Map a canonical row back to the domain record (payload JSON is authoritative). */
function rowToRecord(row: ProviderJobRow): AgnesVideoJobRecord {
  const payload = JSON.parse(row.request_params) as Partial<AgnesVideoJobRecord>;
  return {
    ...payload,
    ref: row.id,
    provider: "agnes",
    state: (payload.state ?? row.status) as AgnesVideoJobState,
    providerJobId: row.provider_task_id ?? payload.providerJobId,
    model: (payload.model ?? row.provider_model) as AgnesVideoJobRecord["model"],
    submittedAt: row.submitted_at ?? payload.submittedAt,
    lastPolledAt: row.polled_at ?? payload.lastPolledAt,
    archivalStatus: fromCanonicalArchival(row.archival_status),
    retryCount: row.retry_count,
    estimatedCostUsd: row.estimated_cost_usd ?? payload.estimatedCostUsd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as AgnesVideoJobRecord;
}

/**
 * SQLite implementation of {@link AgnesVideoJobStore}. One row per ref; the
 * denormalized columns (provider/provider_task_id/state) exist so SQL-level
 * queries (resume scans, spend audits) never need to parse JSON.
 */
export class AgnesVideoJobStoreSqlite implements AgnesVideoJobStore {
  constructor(private readonly db: SqliteDatabase) {
    // Fail loudly rather than self-heal a divergent shape (see REQUIRED_COLUMNS).
    const rows = db.all(
      "SELECT name FROM pragma_table_info('provider_jobs')",
    ) as { name: string }[];
    const present = new Set(rows.map((r) => r.name));
    if (present.size === 0) {
      throw new Error(
        "provider_jobs is missing — run migrate(db, MIGRATIONS) before constructing AgnesVideoJobStoreSqlite; this store no longer creates its own table",
      );
    }
    const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
    if (missing.length > 0) {
      throw new Error(
        `provider_jobs is missing canonical column(s): ${missing.join(", ")} — the database predates the 040_ band; re-run migrate()`,
      );
    }
  }

  async load(ref: string): Promise<AgnesVideoJobRecord | undefined> {
    const row = this.db.get(
      `SELECT id, provider, provider_model, provider_task_id, status, request_params,
              submitted_at, polled_at, result_url, archival_status, retry_count,
              estimated_cost_usd, created_at, updated_at
         FROM provider_jobs WHERE id = ?`,
      ref,
    ) as ProviderJobRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  async save(record: AgnesVideoJobRecord): Promise<void> {
    // The full record is serialized into request_params: it is the only TEXT
    // column that is NOT NULL and not otherwise typed, and keeping the payload
    // authoritative preserves round-trip fidelity for fields with no column of
    // their own (submitRequest, resultUrls, budgetReservationId, ...).
    const payload = { ...record };
    this.db
      .prepare(
        `INSERT INTO provider_jobs (
           id, request_hash, provider, provider_model, provider_task_id,
           request_params, submitted_at, status, polled_at, result_url,
           archival_status, retry_count, estimated_cost_usd, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           request_hash = excluded.request_hash,
           provider = excluded.provider,
           provider_model = excluded.provider_model,
           provider_task_id = excluded.provider_task_id,
           request_params = excluded.request_params,
           submitted_at = excluded.submitted_at,
           status = excluded.status,
           polled_at = excluded.polled_at,
           result_url = excluded.result_url,
           archival_status = excluded.archival_status,
           retry_count = excluded.retry_count,
           estimated_cost_usd = excluded.estimated_cost_usd,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.ref,
        record.requestHash,
        record.provider,
        record.model,
        record.providerJobId ?? null,
        JSON.stringify(payload),
        record.submittedAt ?? null,
        record.state,
        record.lastPolledAt ?? null,
        record.resultUrls?.[0] ?? null,
        toCanonicalArchival(record.archivalStatus),
        record.retryCount ?? 0,
        record.estimatedCostUsd ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }
}

/**
 * In-memory {@link AgnesVideoJobStore} for tests and dry runs. Never the
 * production store (spec §18: durable record in SQLite/state).
 */
export class InMemoryAgnesVideoJobStore implements AgnesVideoJobStore {
  private readonly rows = new Map<string, AgnesVideoJobRecord>();
  /** Every saved record, in save order (tests assert the persist-before-poll order). */
  readonly saveOrder: AgnesVideoJobRecord[] = [];

  async load(ref: string): Promise<AgnesVideoJobRecord | undefined> {
    const row = this.rows.get(ref);
    return row === undefined ? undefined : { ...row };
  }

  async save(record: AgnesVideoJobRecord): Promise<void> {
    const copy = { ...record };
    this.saveOrder.push(copy);
    this.rows.set(record.ref, { ...copy });
  }
}

/** Re-export for callers that only need the archival-status literal type. */
export type { AgnesVideoArchivalStatus };
export type { AgnesVideoJobRecord, AgnesVideoJobState };