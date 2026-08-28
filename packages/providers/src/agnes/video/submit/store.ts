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

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS provider_jobs (
  ref TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Numeric shape of one stored row. */
interface ProviderJobRow {
  ref: string;
  provider: string;
  provider_task_id: string | null;
  state: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

/** Map a row back to the domain record (payload JSON is authoritative). */
function rowToRecord(row: ProviderJobRow): AgnesVideoJobRecord {
  const payload = JSON.parse(row.payload) as Partial<AgnesVideoJobRecord>;
  return {
    ...payload,
    ref: row.ref,
    provider: "agnes",
    state: payload.state ?? (row.state as AgnesVideoJobState),
    providerJobId: row.provider_task_id ?? payload.providerJobId,
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
    db.exec(TABLE_SQL);
  }

  async load(ref: string): Promise<AgnesVideoJobRecord | undefined> {
    const row = this.db.get(
      "SELECT ref, provider, provider_task_id, state, payload, created_at, updated_at FROM provider_jobs WHERE ref = ?",
      ref,
    ) as ProviderJobRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  async save(record: AgnesVideoJobRecord): Promise<void> {
    const payload = { ...record };
    this.db
      .prepare(
        `INSERT INTO provider_jobs (ref, provider, provider_task_id, state, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           provider = excluded.provider,
           provider_task_id = excluded.provider_task_id,
           state = excluded.state,
           payload = excluded.payload,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.ref,
        record.provider,
        record.providerJobId ?? null,
        record.state,
        JSON.stringify(payload),
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