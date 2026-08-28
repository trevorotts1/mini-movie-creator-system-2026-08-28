/**
 * CostLedger — the atomic cumulative budget reservation engine (spec §4).
 *
 * THE RULE (spec §4, §32 "Spend"):
 * - cumulative projected paid spend < limit ($25.00 default) → proceeds
 *   automatically;
 * - a reservation that would reach/exceed the limit → `requires_approval`,
 *   nothing is reserved, the caller stops for operator sign-off;
 * - reservations are atomic against ONE shared ledger: five parallel
 *   workers each requesting $24.99 against an empty ledger yield exactly
 *   ONE approval — the winner takes the write lock first; everyone else
 *   re-reads the cumulative total inside the same locked transaction and
 *   sees the winner's row.
 *
 * Atomicity mechanism: `BEGIN IMMEDIATE` grabs SQLite's write lock BEFORE
 * the cumulative SELECT, so read-modify-write of the total is serialized
 * even across separate connections/processes on one database file. Plain
 * `BEGIN` (deferred) would let two connections both read the old total
 * inside a transaction and then fail at COMMIT — too late for a gate.
 * A single shared `SqliteDatabase` connection is additionally serialized
 * by Node's single thread; `BEGIN IMMEDIATE` covers the multi-connection
 * (CLI + worker + API) case.
 *
 * Included subscription quota is tracked in `cost_quota_usage` and is
 * NEVER part of the paid gate (spec §4).
 */
import type { SqliteDatabase, SqlValue } from "@mmcs/database";
import { centsToUsd, usdToCents } from "./money.js";
import {
  createCostEngineSchema,
} from "./schema.js";
import {
  isApproved,
  type ProviderUsage,
  type QuotaEntry,
  type QuotaUsage,
  type QuotaUsageInput,
  type Reservation,
  type ReservationDecision,
  type ReservationInput,
  type ReservationKind,
  type ReservationStatus,
  type SpendSummary,
} from "./types.js";

/** Error thrown for invalid reservation requests (bad amounts, unknown ids). */
export class CostEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostEngineError";
  }
}

export interface CostLedgerOptions {
  /** Cumulative paid-spend gate in USD. Default 25 (spec §4). */
  limitUsd?: number;
  /** Clock override for tests. */
  now?: () => string;
  /** Id generator override for tests. */
  generateId?: () => string;
}

const KINDS: readonly ReservationKind[] = ["paid", "included"];

function defaultId(): string {
  return `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Shape of a `cost_reservations` row as it comes back from SQLite. */
interface ReservationRow {
  id: string;
  job_id: string | null;
  episode_id: string | null;
  provider: string;
  provider_model: string;
  kind: string;
  status: string;
  estimated_cents: number | bigint;
  actual_cents: number | bigint | null;
  requested_seconds: number | null;
  generated_seconds: number | null;
  accepted_seconds: number | null;
  rejected_seconds: number | null;
  retries: number | bigint | null;
  approved_at: string | null;
  approval_note: string | null;
  release_reason: string | null;
  created_at: string;
  updated_at: string;
}

function num(value: number | bigint | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value);
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    provider: row.provider,
    providerModel: row.provider_model,
    kind: row.kind as ReservationKind,
    status: row.status as ReservationStatus,
    estimatedUsd: centsToUsd(Number(row.estimated_cents)),
    actualUsd: row.actual_cents === null ? undefined : centsToUsd(Number(row.actual_cents)),
    requestedSeconds: row.requested_seconds ?? undefined,
    generatedSeconds: row.generated_seconds ?? undefined,
    acceptedSeconds: row.accepted_seconds ?? undefined,
    rejectedSeconds: row.rejected_seconds ?? undefined,
    retries: num(row.retries),
    approvedAt: row.approved_at ?? undefined,
    approvalNote: row.approval_note ?? undefined,
    releaseReason: row.release_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Paid spend that still counts toward the gate: open reservations + committed. */
const PROJECTED_SQL = `
  SELECT COALESCE(SUM(
    CASE status
      WHEN 'reserved'  THEN estimated_cents
      WHEN 'committed' THEN COALESCE(actual_cents, estimated_cents)
      ELSE 0
    END
  ), 0) AS total_cents
  FROM cost_reservations
  WHERE kind = 'paid'
`.trim();

export class CostLedger {
  private readonly db: SqliteDatabase;
  private readonly limitCents: number;
  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(db: SqliteDatabase, options: CostLedgerOptions = {}) {
    this.db = db;
    const limit = options.limitUsd ?? 25;
    this.limitCents = usdToCents(limit);
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? defaultId;
  }

  /** The gate in USD (for display and tests). */
  get limitUsd(): number {
    return centsToUsd(this.limitCents);
  }

  /**
   * Cumulative projected paid spend in USD: open reservations at estimate +
   * committed reservations at actual (estimate fallback when the provider
   * returned no actual). Released reservations no longer count.
   */
  get projectedUsd(): number {
    const row = this.db.get(PROJECTED_SQL);
    return centsToUsd(Number(row?.["total_cents"] ?? 0));
  }

  /**
   * Atomically reserve budget BEFORE submission (spec §18 `BUDGET_RESERVED`).
   *
   * Included-kind (`kind: 'included'`) reservations skip the paid gate by
   * design — they are tracked, never gated (spec §4).
   */
  reserve(input: ReservationInput): ReservationDecision {
    if (!input.provider || input.provider.trim() === "") {
      throw new CostEngineError("provider is required");
    }
    if (!input.providerModel || input.providerModel.trim() === "") {
      throw new CostEngineError("providerModel is required");
    }
    if (input.kind !== undefined && !KINDS.includes(input.kind)) {
      throw new CostEngineError(`invalid reservation kind: ${String(input.kind)}`);
    }
    const kind: ReservationKind = input.kind ?? "paid";
    const estimatedCents = usdToCents(input.estimatedUsd);
    if (input.force && kind !== "paid") {
      throw new CostEngineError("force applies to paid reservations only");
    }
    if (input.force && !input.approvalNote) {
      throw new CostEngineError("force requires an approvalNote (who approved, when, why)");
    }

    const now = this.now();
    const id = this.generateId();

    // BEGIN IMMEDIATE takes the write lock before the SELECT below, so the
    // read-modify-write of the cumulative total is atomic across processes
    // (deferred BEGIN would let two connections read the same old total and
    // both pass the gate — the failure would surface only at COMMIT, too
    // late for a spend gate).
    this.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.get(PROJECTED_SQL);
      const projectedCents = Number(row?.["total_cents"] ?? 0);
      const nextCents = projectedCents + estimatedCents;

      if (kind === "paid" && !input.force && nextCents >= this.limitCents) {
        // Stop BEFORE crossing: no row, no spend, caller asks the operator.
        this.exec("COMMIT");
        return {
          outcome: "requires_approval",
          reason:
            projectedCents < this.limitCents
              ? `request would reach the $${centsToUsd(this.limitCents).toFixed(2)} cumulative spend limit (projected $${centsToUsd(nextCents).toFixed(2)})`
              : `cumulative spend already at/above the $${centsToUsd(this.limitCents).toFixed(2)} limit (projected $${centsToUsd(nextCents).toFixed(2)})`,
          projectedUsd: centsToUsd(nextCents),
          requestUsd: input.estimatedUsd,
          limitUsd: this.limitUsd,
          reservation: undefined,
        } satisfies ReservationDecision;
      }

      this.db
        .prepare(
          `INSERT INTO cost_reservations (
             id, job_id, episode_id, provider, provider_model, kind, status,
             estimated_cents, requested_seconds, generated_seconds,
             accepted_seconds, rejected_seconds, retries,
             approved_at, approval_note, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.jobId ?? null,
          input.episodeId ?? null,
          input.provider,
          input.providerModel,
          kind,
          estimatedCents,
          input.requestedSeconds ?? null,
          input.generatedSeconds ?? null,
          input.acceptedSeconds ?? null,
          input.rejectedSeconds ?? null,
          input.retries ?? null,
          input.force ? now : null,
          input.force ? (input.approvalNote ?? null) : null,
          now,
          now,
        );

      this.exec("COMMIT");
      return {
        outcome: "approved",
        reservation: this.get(id) as Reservation,
        projectedUsd: centsToUsd(nextCents),
        limitUsd: this.limitUsd,
      } satisfies ReservationDecision;
    } catch (err) {
      try {
        this.exec("ROLLBACK");
      } catch {
        // a statement-level abort may have resolved the transaction already
      }
      throw err;
    }
  }

  /**
   * Approve a previously stopped request. Marks the operator authorization,
   * then reserves with the gate bypassed — the ONLY path across the limit.
   */
  approveAndReserve(input: ReservationInput, approvalNote: string): ReservationDecision {
    return this.reserve({ ...input, force: true, approvalNote });
  }

  /**
   * Commit a reservation: the generation finished; record the actual cost if
   * the provider reported one (falls back to the estimate). Actuals replace
   * estimates in the projected total.
   */
  commit(id: string, actualUsd?: number, usage?: { generatedSeconds?: number; acceptedSeconds?: number; rejectedSeconds?: number; retries?: number }): Reservation {
    const actualCents = actualUsd === undefined ? undefined : usdToCents(actualUsd);
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.getReservationRow(id);
      if (!row) throw new CostEngineError(`unknown reservation: ${id}`);
      if (row.status === "released") {
        throw new CostEngineError(`reservation ${id} was released; commit refused`);
      }
      this.db
        .prepare(
          `UPDATE cost_reservations
           SET status = 'committed',
               actual_cents = ?,
               generated_seconds = COALESCE(?, generated_seconds),
               accepted_seconds = COALESCE(?, accepted_seconds),
               rejected_seconds = COALESCE(?, rejected_seconds),
               retries = COALESCE(?, retries),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          actualCents ?? null,
          usage?.generatedSeconds ?? null,
          usage?.acceptedSeconds ?? null,
          usage?.rejectedSeconds ?? null,
          usage?.retries ?? null,
          now,
          id,
        );
      return this.get(id) as Reservation;
    });
  }

  /**
   * Release a reservation on failure/rejection (spec §4): its estimate stops
   * counting toward the gate. Idempotent — releasing a released reservation
   * returns the existing row unchanged.
   */
  release(id: string, reason: string): Reservation {
    if (!reason || reason.trim() === "") {
      throw new CostEngineError("release reason is required");
    }
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.getReservationRow(id);
      if (!row) throw new CostEngineError(`unknown reservation: ${id}`);
      if (row.status === "committed") {
        // Committed = the generation happened and was paid; its cost is
        // already in the ledger. Releasing it would erase real spend.
        throw new CostEngineError(`reservation ${id} is committed; release refused`);
      }
      if (row.status === "released") {
        return this.get(id) as Reservation;
      }
      this.db
        .prepare(
          `UPDATE cost_reservations
           SET status = 'released', release_reason = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          reason,
          now,
          id,
        );
      return this.get(id) as Reservation;
    });
  }

  get(id: string): Reservation | undefined {
    const row = this.getReservationRow(id);
    return row ? mapReservation(row) : undefined;
  }

  /** List reservations, newest first, optionally filtered by status. */
  list(filter?: { status?: ReservationStatus; kind?: ReservationKind; episodeId?: string; jobId?: string }): Reservation[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.episodeId) {
      clauses.push("episode_id = ?");
      params.push(filter.episodeId);
    }
    if (filter?.jobId) {
      clauses.push("job_id = ?");
      params.push(filter.jobId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.all(
      `SELECT * FROM cost_reservations${where} ORDER BY created_at DESC, id DESC`,
      ...params,
    );
    return rows.map((r) => mapReservation(r as unknown as ReservationRow));
  }

  /** Rollups for the estimate gate and status displays (spec §4). */
  summary(): SpendSummary {
    const limitUsd = this.limitUsd;
    const openReservedCents = this.scalarCents(
      "SELECT COALESCE(SUM(estimated_cents), 0) AS c FROM cost_reservations WHERE kind = 'paid' AND status = 'reserved'",
    );
    const committedActualCents = this.scalarCents(
      "SELECT COALESCE(SUM(actual_cents), 0) AS c FROM cost_reservations WHERE kind = 'paid' AND status = 'committed' AND actual_cents IS NOT NULL",
    );

    const byEpisode = this.groupCents("episode_id").map(([episodeId, cents]) => ({
      episodeId,
      projectedUsd: centsToUsd(cents),
    }));
    const byDay = this.groupCentsByExpression("substr(created_at, 1, 10)").map(([day, cents]) => ({
      day,
      projectedUsd: centsToUsd(cents),
    }));
    const byProvider = this.groupCents("provider").map(([provider, cents]) => ({
      provider,
      projectedUsd: centsToUsd(cents),
    }));

    return {
      limitUsd,
      projectedTotalUsd: this.projectedUsd,
      openReservedUsd: centsToUsd(openReservedCents),
      committedActualUsd: centsToUsd(committedActualCents),
      byEpisode,
      byDay,
      byProvider,
    };
  }

  /** Per provider/model usage aggregation over non-released reservations. */
  providerUsage(): ProviderUsage[] {
    const rows = this.db.all(`
      SELECT provider,
             provider_model,
             COALESCE(SUM(requested_seconds), 0)  AS requested_seconds,
             COALESCE(SUM(generated_seconds), 0)  AS generated_seconds,
             COALESCE(SUM(accepted_seconds), 0)   AS accepted_seconds,
             COALESCE(SUM(rejected_seconds), 0)   AS rejected_seconds,
             COALESCE(SUM(retries), 0)            AS retries,
             COALESCE(SUM(estimated_cents), 0)    AS estimated_cents,
             COALESCE(SUM(actual_cents), 0)       AS actual_cents
      FROM cost_reservations
      WHERE kind = 'paid' AND status IN ('reserved', 'committed')
      GROUP BY provider, provider_model
      ORDER BY provider, provider_model
    `);
    return rows.map((r) => {
      const row = r as unknown as Record<string, number | bigint | string | null>;
      return {
        provider: String(row["provider"]),
        providerModel: String(row["provider_model"]),
        requestedSeconds: Number(row["requested_seconds"] ?? 0),
        generatedSeconds: Number(row["generated_seconds"] ?? 0),
        acceptedSeconds: Number(row["accepted_seconds"] ?? 0),
        rejectedSeconds: Number(row["rejected_seconds"] ?? 0),
        retries: Number(row["retries"] ?? 0),
        estimatedUsd: centsToUsd(Number(row["estimated_cents"] ?? 0)),
        actualUsd: centsToUsd(Number(row["actual_cents"] ?? 0)),
      };
    });
  }

  // ------------------------------------------------------------------
  // Included quota (tracked separately — never part of the paid gate)
  // ------------------------------------------------------------------

  /** Record included/free-allowance consumption. Never gated, never counted as paid. */
  recordQuotaUsage(input: QuotaUsageInput): QuotaEntry {
    if (!input.provider?.trim()) throw new CostEngineError("provider is required");
    if (!input.providerModel?.trim()) throw new CostEngineError("providerModel is required");
    if (!input.period?.trim()) throw new CostEngineError("period is required (e.g. '2026-08-28' or a billing-period id)");
    if (!input.unitsKind?.trim()) throw new CostEngineError("unitsKind is required (e.g. 'seconds', 'requests')");
    if (!Number.isFinite(input.units) || input.units < 0) {
      throw new CostEngineError(`units must be a non-negative finite number, got ${input.units}`);
    }
    const now = this.now();
    const id = `quota-${this.generateId()}`;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cost_quota_usage (id, reservation_id, provider, provider_model, period, units_kind, units, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
        input.reservationId ?? null,
        input.provider,
        input.providerModel,
        input.period,
        input.unitsKind,
        input.units,
        input.note ?? null,
        now,
      );
    });
    return {
      id,
      provider: input.provider,
      providerModel: input.providerModel,
      period: input.period,
      unitsKind: input.unitsKind,
      units: input.units,
      reservationId: input.reservationId,
      note: input.note,
      createdAt: now,
    };
  }

  /** Sum included-quota usage per provider/model/period/unitsKind. */
  quotaUsage(filter?: { provider?: string; providerModel?: string; period?: string }): QuotaUsage[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter?.provider) {
      clauses.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter?.providerModel) {
      clauses.push("provider_model = ?");
      params.push(filter.providerModel);
    }
    if (filter?.period) {
      clauses.push("period = ?");
      params.push(filter.period);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.all(
      `SELECT provider, provider_model, period, units_kind, COALESCE(SUM(units), 0) AS units
       FROM cost_quota_usage${where}
       GROUP BY provider, provider_model, period, units_kind
       ORDER BY provider, provider_model, period, units_kind`,
      ...params,
    );
    return rows.map((r) => {
      const row = r as unknown as Record<string, number | bigint | string | null>;
      return {
        provider: String(row["provider"]),
        providerModel: String(row["provider_model"]),
        period: String(row["period"]),
        unitsKind: String(row["units_kind"]),
        unitsUsed: Number(row["units"] ?? 0),
      };
    });
  }

  /** Raw entries (audit view). */
  quotaEntries(filter?: { provider?: string; period?: string }): QuotaEntry[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter?.provider) {
      clauses.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter?.period) {
      clauses.push("period = ?");
      params.push(filter.period);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.all(
      `SELECT * FROM cost_quota_usage${where} ORDER BY created_at DESC, id DESC`,
      ...params,
    );
    return rows.map((r) => {
      const row = r as unknown as Record<string, number | bigint | string | null>;
      return {
        id: String(row["id"]),
        reservationId: row["reservation_id"] === null ? undefined : String(row["reservation_id"]),
        provider: String(row["provider"]),
        providerModel: String(row["provider_model"]),
        period: String(row["period"]),
        unitsKind: String(row["units_kind"]),
        units: Number(row["units"] ?? 0),
        note: row["note"] === null ? undefined : String(row["note"]),
        createdAt: String(row["created_at"]),
      };
    });
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private getReservationRow(id: string): ReservationRow | undefined {
    const row = this.db.get("SELECT * FROM cost_reservations WHERE id = ?", id);
    return row ? (row as unknown as ReservationRow) : undefined;
  }

  private scalarCents(sql: string): number {
    const row = this.db.get(sql);
    return Number(row?.["c"] ?? 0);
  }

  /** Group non-released paid spend by a column (episode/provider), cents per key. */
  private groupCents(column: "episode_id" | "provider"): Array<[string, number]> {
    const rows = this.db.all(`
      SELECT COALESCE(${column}, '(none)') AS k, COALESCE(SUM(
        CASE status
          WHEN 'reserved'  THEN estimated_cents
          WHEN 'committed' THEN COALESCE(actual_cents, estimated_cents)
          ELSE 0
        END
      ), 0) AS c
      FROM cost_reservations
      WHERE kind = 'paid'
      GROUP BY k ORDER BY k
    `);
    return rows.map((r) => [String(r["k"]), Number(r["c"] ?? 0)] as [string, number]);
  }

  private groupCentsByExpression(expr: string): Array<[string, number]> {
    const rows = this.db.all(`
      SELECT ${expr} AS k, COALESCE(SUM(
        CASE status
          WHEN 'reserved'  THEN estimated_cents
          WHEN 'committed' THEN COALESCE(actual_cents, estimated_cents)
          ELSE 0
        END
      ), 0) AS c
      FROM cost_reservations
      WHERE kind = 'paid'
      GROUP BY k ORDER BY k
    `);
    return rows.map((r) => [String(r["k"]), Number(r["c"] ?? 0)] as [string, number]);
  }

  private exec(sql: string): void {
    this.db.exec(sql);
  }
}

export { createCostEngineSchema };
export { isApproved };