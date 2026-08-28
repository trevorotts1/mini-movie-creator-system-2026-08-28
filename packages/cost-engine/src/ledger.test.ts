/// <reference types="node" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "@mmcs/database";
import { createCostEngineSchema } from "./schema.js";
import { CostEngineError, CostLedger } from "./ledger.js";
import { centsToUsd, usdToCents, MoneyError } from "./money.js";
import { DEFAULT_AUTO_SPEND_LIMIT_USD, isApproved, type ReservationInput } from "./types.js";

let dir: string;
let db: SqliteDatabase;
let ledger: CostLedger;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-cost-engine-"));
  db = connectSqlite({ path: join(dir, "cost.db") });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DROP TABLE IF EXISTS cost_reservations");
  db.exec("DROP TABLE IF EXISTS cost_quota_usage");
  createCostEngineSchema(db);
  ledger = new CostLedger(db, { now: () => "2026-08-29T00:00:00.000Z" });
});

const paid = (overrides: Partial<ReservationInput> = {}): ReservationInput => ({
  provider: "agnes",
  providerModel: "agnes-video-2.5-flash",
  estimatedUsd: 5,
  ...overrides,
});

describe("money — integer-cent exactness", () => {
  it("converts USD to cents exactly", () => {
    expect(usdToCents(25)).toBe(2500);
    expect(usdToCents(24.99)).toBe(2499);
    expect(usdToCents(0.01)).toBe(1);
    expect(centsToUsd(2499)).toBeCloseTo(24.99, 10);
  });

  it("rejects sub-cent precision, negatives, and non-finite amounts", () => {
    expect(() => usdToCents(0.005)).toThrow(MoneyError);
    expect(() => usdToCents(1.999)).toThrow(MoneyError);
    expect(() => usdToCents(-1)).toThrow(MoneyError);
    expect(() => usdToCents(Number.NaN)).toThrow(MoneyError);
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it("accepts every 2-decimal value across magnitudes (no false sub-cent rejection)", () => {
    // Regression: near the double-precision cents boundary a fixed 1e-6
    // tolerance falsely rejected legitimate 2-decimal values (e.g.
    // 10_000_000_000_000.37 whose usd*100 drifts ~0.125 in a double).
    for (const usd of [0.07, 19.99, 24.99, 1234567.89, 9876543.21, 10000000000000.37, 40000000000000.37]) {
      expect(usdToCents(usd)).toBe(Math.round(usd * 100));
    }
  });
});

describe("the $25 gate — spec §4 / §32 Spend acceptance", () => {
  it("$24.99 cumulative projected spend proceeds automatically", () => {
    const d1 = ledger.reserve(paid({ estimatedUsd: 24.99 }));
    expect(isApproved(d1)).toBe(true);
    expect(d1.projectedUsd).toBeCloseTo(24.99, 10);

    // Released spend stops counting, so a fresh $24.99 proceeds again.
    ledger.release((d1 as { reservation: { id: string } }).reservation.id, "provider failed before submission");
    const d2 = ledger.reserve(paid({ estimatedUsd: 24.99 }));
    expect(isApproved(d2)).toBe(true);
  });

  it("a request that would reach $25.00 stops for approval (nothing reserved)", () => {
    const d = ledger.reserve(paid({ estimatedUsd: 25.0 }));
    expect(d.outcome).toBe("requires_approval");
    if (d.outcome !== "requires_approval") return;
    expect(d.projectedUsd).toBeCloseTo(25.0, 10);
    expect(d.limitUsd).toBe(25);
    expect(d.reservation).toBeUndefined();
    // The stop wrote no row: projected stays 0, and a $24.99 request now passes.
    expect(ledger.projectedUsd).toBe(0);
  });

  it("crossing is checked cumulatively: $10 then $14.99 pass, $0.02 stops", () => {
    expect(isApproved(ledger.reserve(paid({ estimatedUsd: 10 })))).toBe(true);
    expect(isApproved(ledger.reserve(paid({ estimatedUsd: 14.99 })))).toBe(true);
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);

    const stopped = ledger.reserve(paid({ estimatedUsd: 0.02 }));
    expect(stopped.outcome).toBe("requires_approval");
    if (stopped.outcome !== "requires_approval") return;
    expect(stopped.projectedUsd).toBeCloseTo(25.01, 10);
    expect(stopped.reason).toContain("$25.00");
  });

  it("a request that would reach $25.00 from $24.99 reserved stops (boundary is >=)", () => {
    ledger.reserve(paid({ estimatedUsd: 24.99 }));
    const stopped = ledger.reserve(paid({ estimatedUsd: 0.01 }));
    expect(stopped.outcome).toBe("requires_approval");
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
  });

  it("configurable limit is honored (AUTO_SPEND_LIMIT_USD)", () => {
    const small = new CostLedger(db, { limitUsd: 10, now: () => "2026-08-29T00:00:00.000Z" });
    expect(small.limitUsd).toBe(10);
    expect(isApproved(small.reserve(paid({ estimatedUsd: 9.99 })))).toBe(true);
    expect(small.reserve(paid({ estimatedUsd: 0.01 })).outcome).toBe("requires_approval");
  });

  it("committed actual cost replaces the estimate in the projected total", () => {
    const d = ledger.reserve(paid({ estimatedUsd: 10 }));
    if (!isApproved(d)) throw new Error("expected approval");
    ledger.commit(d.reservation.id, 12.34);
    expect(ledger.projectedUsd).toBeCloseTo(12.34, 10);
  });

  it("released reservations stop counting toward the gate (release on failure, spec §4)", () => {
    const d = ledger.reserve(paid({ estimatedUsd: 24.99 }));
    if (!isApproved(d)) throw new Error("expected approval");
    ledger.release(d.reservation.id, "generation rejected by provider");
    expect(ledger.projectedUsd).toBe(0);
    // Gate is open again.
    expect(isApproved(ledger.reserve(paid({ estimatedUsd: 24.99 })))).toBe(true);
  });

  it("explicit approval is the only path across the limit, and it is persisted", () => {
    const d = ledger.approveAndReserve(
      paid({ estimatedUsd: 30 }),
      "operator Trevor approved overage for episode finale, 2026-08-29",
    );
    expect(isApproved(d)).toBe(true);
    if (!isApproved(d)) return;
    expect(d.reservation.approvedAt).toBe("2026-08-29T00:00:00.000Z");
    expect(d.reservation.approvalNote).toContain("Trevor");
    expect(ledger.projectedUsd).toBeCloseTo(30, 10);

    // force without a note is refused (approvals must be attributable)
    expect(() => ledger.reserve(paid({ estimatedUsd: 100, force: true }))).toThrow(CostEngineError);
  });

  it("the stop result explains which side of the limit the ledger was on", () => {
    // Ledger already at/above the limit (via approval) → different phrasing.
    ledger.approveAndReserve(paid({ estimatedUsd: 25 }), "approved for test");
    const d = ledger.reserve(paid({ estimatedUsd: 1 }));
    expect(d.outcome).toBe("requires_approval");
    if (d.outcome !== "requires_approval") return;
    expect(d.reason).toContain("already at/above");
  });
});

describe("atomicity — concurrent reservations cannot bypass the gate", () => {
  it("5 parallel reservations of $24.99: exactly 1 succeeds", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => ledger.reserve(paid({ estimatedUsd: 24.99 }))),
      ),
    );
    const approved = results.filter(isApproved);
    const stopped = results.filter((r) => r.outcome === "requires_approval");
    expect(approved).toHaveLength(1);
    expect(stopped).toHaveLength(4);
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
    expect(ledger.list({ status: "reserved" })).toHaveLength(1);
  });

  it("5 parallel reservations of $6 against a $25 limit: exactly 4 succeed (20 < 25 <= 24)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => Promise.resolve().then(() => ledger.reserve(paid({ estimatedUsd: 6 })))),
    );
    expect(results.filter(isApproved)).toHaveLength(4);
    expect(results.filter((r) => r.outcome === "requires_approval")).toHaveLength(1);
    expect(ledger.projectedUsd).toBeCloseTo(24, 10);
  });

  it("separate connections on one database file cannot double-book (multi-process shape)", async () => {
    // The real CLI/worker/API topology: each process opens its own connection.
    const db2 = connectSqlite({ path: join(dir, "cost.db") });
    try {
      const ledger2 = new CostLedger(db2, { now: () => "2026-08-29T00:00:00.000Z" });
      const results = await Promise.all([
        Promise.resolve().then(() => ledger.reserve(paid({ estimatedUsd: 24.99 }))),
        Promise.resolve().then(() => ledger2.reserve(paid({ estimatedUsd: 24.99 }))),
        Promise.resolve().then(() => ledger.reserve(paid({ estimatedUsd: 24.99 }))),
        Promise.resolve().then(() => ledger2.reserve(paid({ estimatedUsd: 24.99 }))),
        Promise.resolve().then(() => ledger.reserve(paid({ estimatedUsd: 24.99 }))),
      ]);
      expect(results.filter(isApproved)).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "requires_approval")).toHaveLength(4);
      // Both connections agree on the total.
      expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
      expect(new CostLedger(db2).projectedUsd).toBeCloseTo(24.99, 10);
    } finally {
      db2.close();
    }
  });

  it("committed actuals count too: 4x $6 reserved+committed at estimate, the 5th $6 stops", async () => {
    for (let i = 0; i < 4; i += 1) {
      const d = ledger.reserve(paid({ estimatedUsd: 6 }));
      if (!isApproved(d)) throw new Error("expected approval");
      ledger.commit(d.reservation.id);
    }
    expect(ledger.reserve(paid({ estimatedUsd: 6 })).outcome).toBe("requires_approval");
  });

  it("reserve joins a caller's open transaction instead of crashing on nested BEGIN", () => {
    // Regression: raw BEGIN IMMEDIATE inside an open transaction throws
    // "cannot start a transaction within a transaction".
    const result = db.transaction(() => ledger.reserve(paid({ estimatedUsd: 24.99 })));
    expect(isApproved(result)).toBe(true);
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
    expect(db.inTransaction).toBe(false);
  });

  it("a failing reserve inside a caller's transaction does not roll back the caller's work", () => {
    // The gate stop must not destroy the caller's outer transaction.
    let callerSaw: string | undefined;
    db.transaction(() => {
      db.exec("INSERT INTO cost_quota_usage (id, provider, provider_model, period, units_kind, units, created_at) VALUES ('caller-row', 'p', 'm', 'per', 'u', 1, '2026-08-29')");
      const stopped = ledger.reserve(paid({ estimatedUsd: 30 }));
      expect(stopped.outcome).toBe("requires_approval");
      callerSaw = db.get("SELECT id FROM cost_quota_usage WHERE id = 'caller-row'")?.["id"] as string;
    });
    expect(callerSaw).toBe("caller-row");
    // Caller's outer transaction committed intact.
    expect(db.get("SELECT id FROM cost_quota_usage WHERE id = 'caller-row'")?.["id"]).toBe("caller-row");
  });

  it("a throwing reserve inside a caller's transaction rolls back with the caller, not alone", () => {
    let callerSaw: string | undefined;
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO cost_quota_usage (id, provider, provider_model, period, units_kind, units, created_at) VALUES ('caller-row-2', 'p', 'm', 'per', 'u', 1, '2026-08-29')");
        // Unknown reservation id makes commit() throw inside reserve's window.
        ledger.reserve(paid({ estimatedUsd: 1 }));
        throw Object.assign(new Error("caller boom"), { reserveSideEffect: true });
      }),
    ).toThrow("caller boom");
    // Outer transaction rolled back: neither the caller row nor the
    // reservation survives — they are one atomic unit.
    callerSaw = db.get("SELECT id FROM cost_quota_usage WHERE id = 'caller-row-2'")?.["id"] as string | undefined;
    expect(callerSaw).toBeUndefined();
    expect(ledger.projectedUsd).toBe(0);
  });
});

describe("included quota — tracked separately, never gated (spec §4)", () => {
  it("included reservations proceed even past the paid limit", () => {
    // Fill the paid ledger to the limit.
    ledger.reserve(paid({ estimatedUsd: 24.99 }));
    // An included (subscription) reservation sails through regardless.
    const d = ledger.reserve(paid({ estimatedUsd: 500, kind: "included" }));
    expect(isApproved(d)).toBe(true);
    // And it did not move the paid gate.
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
    // A paid request now stops.
    expect(ledger.reserve(paid({ estimatedUsd: 0.01 })).outcome).toBe("requires_approval");
  });

  it("recordQuotaUsage tracks consumption without touching the paid gate", () => {
    const before = ledger.projectedUsd;
    ledger.recordQuotaUsage({
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      period: "2026-08",
      unitsKind: "seconds",
      units: 96,
      note: "monthly included allowance",
    });
    ledger.recordQuotaUsage({
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      period: "2026-08",
      unitsKind: "seconds",
      units: 24,
    });
    expect(ledger.projectedUsd).toBe(before);

    const usage = ledger.quotaUsage({ period: "2026-08" });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.unitsUsed).toBe(120);
    expect(usage[0]?.unitsKind).toBe("seconds");
  });

  it("quota usage aggregates per provider/model/period/unitsKind", () => {
    ledger.recordQuotaUsage({
      provider: "fish-audio",
      providerModel: "s1",
      period: "2026-08",
      unitsKind: "requests",
      units: 2,
    });
    ledger.recordQuotaUsage({
      provider: "fish-audio",
      providerModel: "s1-pro",
      period: "2026-08",
      unitsKind: "requests",
      units: 1,
    });
    ledger.recordQuotaUsage({
      provider: "fish-audio",
      providerModel: "s1",
      period: "2026-09",
      unitsKind: "requests",
      units: 5,
    });
    const all = ledger.quotaUsage();
    expect(all).toHaveLength(3);
    const s1Aug = all.find((u) => u.providerModel === "s1" && u.period === "2026-08");
    expect(s1Aug?.unitsUsed).toBe(2);
    const s1Sep = all.find((u) => u.providerModel === "s1" && u.period === "2026-09");
    expect(s1Sep?.unitsUsed).toBe(5);
  });

  it("recordQuotaUsage rejects bad input", () => {
    expect(() =>
      ledger.recordQuotaUsage({ provider: "", providerModel: "m", period: "p", unitsKind: "u", units: 1 }),
    ).toThrow(CostEngineError);
    expect(() =>
      ledger.recordQuotaUsage({ provider: "a", providerModel: "m", period: "p", unitsKind: "u", units: -1 }),
    ).toThrow(CostEngineError);
    expect(() =>
      ledger.recordQuotaUsage({ provider: "a", providerModel: "m", period: "", unitsKind: "u", units: 1 }),
    ).toThrow(CostEngineError);
  });
});

describe("validation and lifecycle", () => {
  it("refuses invalid reservation inputs", () => {
    expect(() => ledger.reserve(paid({ provider: "" }))).toThrow(CostEngineError);
    expect(() => ledger.reserve(paid({ providerModel: "" }))).toThrow(CostEngineError);
    expect(() => ledger.reserve(paid({ estimatedUsd: -5 }))).toThrow(MoneyError);
    expect(() => ledger.reserve(paid({ estimatedUsd: Number.NaN }))).toThrow(MoneyError);
    expect(() => ledger.reserve(paid({ kind: "bogus" as never }))).toThrow(CostEngineError);
  });

  it("commit then release is refused; release is idempotent", () => {
    const d = ledger.reserve(paid({ estimatedUsd: 3 }));
    if (!isApproved(d)) throw new Error("expected approval");
    const committed = ledger.commit(d.reservation.id, 3.5, { generatedSeconds: 8, retries: 1 });
    expect(committed.status).toBe("committed");
    expect(committed.actualUsd).toBeCloseTo(3.5, 10);
    expect(committed.generatedSeconds).toBe(8);

    expect(() => ledger.release(d.reservation.id, "late failure")).toThrow(/committed; release refused/);

    const d2 = ledger.reserve(paid({ estimatedUsd: 1 }));
    if (!isApproved(d2)) throw new Error("expected approval");
    const released = ledger.release(d2.reservation.id, "failed");
    expect(released.status).toBe("released");
    expect(released.releaseReason).toBe("failed");
    // Idempotent second release returns the row unchanged.
    const again = ledger.release(d2.reservation.id, "different reason ignored");
    expect(again.releaseReason).toBe("failed");
  });

  it("default limit is 25 and the default clock/id generate plausible values", () => {
    const plain = new CostLedger(db);
    expect(plain.limitUsd).toBe(DEFAULT_AUTO_SPEND_LIMIT_USD);
    const d = plain.reserve(paid({ estimatedUsd: 1 }));
    if (!isApproved(d)) throw new Error("expected approval");
    expect(d.reservation.id).toMatch(/^res-/);
    expect(new Date(d.reservation.createdAt).getTime()).not.toBeNaN();
  });

  it("summary rolls up per episode/day/provider", () => {
    ledger.reserve(paid({ estimatedUsd: 10, episodeId: "ep-1", provider: "agnes" }));
    ledger.reserve(paid({ estimatedUsd: 5, episodeId: "ep-2", provider: "kie" }));
    const s = ledger.summary();
    expect(s.limitUsd).toBe(25);
    expect(s.projectedTotalUsd).toBeCloseTo(15, 10);
    expect(s.openReservedUsd).toBeCloseTo(15, 10);
    expect(s.committedActualUsd).toBe(0);
    const ep1 = s.byEpisode.find((e) => e.episodeId === "ep-1");
    expect(ep1?.projectedUsd).toBeCloseTo(10, 10);
    expect(s.byDay[0]?.day).toBe("2026-08-29");
    expect(s.byProvider.find((p) => p.provider === "agnes")?.projectedUsd).toBeCloseTo(10, 10);
  });

  it("providerUsage aggregates spec §4 metrics per provider/model", () => {
    ledger.reserve(
      paid({
        estimatedUsd: 2,
        provider: "agnes",
        providerModel: "agnes-video-2.5-flash",
        requestedSeconds: 8,
        retries: 1,
      }),
    );
    const d = ledger.reserve(
      paid({ estimatedUsd: 2, provider: "agnes", providerModel: "agnes-video-2.5-flash", requestedSeconds: 12 }),
    );
    if (!isApproved(d)) throw new Error("expected approval");
    ledger.commit(d.reservation.id, 2, { generatedSeconds: 12, acceptedSeconds: 12, rejectedSeconds: 0 });
    ledger.reserve(paid({ estimatedUsd: 2, provider: "agnes", providerModel: "agnes-video-2.5-regular" }));

    const usage = ledger.providerUsage();
    const flash = usage.find((u) => u.providerModel === "agnes-video-2.5-flash");
    expect(flash?.requestedSeconds).toBe(20);
    expect(flash?.generatedSeconds).toBe(12);
    expect(flash?.acceptedSeconds).toBe(12);
    expect(flash?.retries).toBe(1);
    expect(flash?.estimatedUsd).toBeCloseTo(4, 10);
    expect(flash?.actualUsd).toBeCloseTo(2, 10);
    // The released row's metrics do not appear (only reserved/committed).
  });

  it("list filters by status, kind, episode, and job", () => {
    const a = ledger.reserve(paid({ estimatedUsd: 1, episodeId: "ep-x", jobId: "job-1" }));
    if (!isApproved(a)) throw new Error("expected approval");
    ledger.reserve(paid({ estimatedUsd: 1, kind: "included" }));
    expect(ledger.list({ status: "reserved" })).toHaveLength(2);
    expect(ledger.list({ kind: "included" })).toHaveLength(1);
    expect(ledger.list({ episodeId: "ep-x" })).toHaveLength(1);
    expect(ledger.list({ jobId: "job-1" })[0]?.id).toBe(a.reservation.id);
    expect(ledger.list()).toHaveLength(2);
  });
});