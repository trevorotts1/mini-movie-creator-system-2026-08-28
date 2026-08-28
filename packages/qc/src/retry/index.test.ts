import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  RetryError,
  attemptsUsedOnRoute,
  buildRepairPlan,
  isWanEligible,
  resolvePolicy,
  type RetryHistoryEntry,
  type ShotContext,
  type SpendGate,
} from "./index.js";

/** Static-cost estimator: every attempt on every route costs `cost`. */
function flatEstimator(cost: number | null) {
  return { estimateCost: () => cost };
}

const ALLOW_ALL: SpendGate = { canSpend: () => ({ allowed: true }) };

function denyGate(reason = "denied"): SpendGate {
  return { canSpend: () => ({ allowed: false, reason }) };
}

function history(
  shotId: string,
  routeId: RetryHistoryEntry["routeId"],
  count: number,
): RetryHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    shotId,
    routeId,
    attempt: i + 1,
    at: "2026-08-28T00:00:00Z",
    cost: 0.1,
  }));
}

function episode(shots: ShotContext[], failedShotId: string) {
  return {
    episodeId: "S01E01",
    shots,
    failedShotId,
    history: [] as RetryHistoryEntry[],
    costEstimator: flatEstimator(0.1),
    spendGate: ALLOW_ALL,
  };
}

describe("buildRepairPlan — single-shot scope", () => {
  const shots: ShotContext[] = [
    { shotId: "S01E01_SC01_SH01", targetDurationSeconds: 8 },
    { shotId: "S01E01_SC01_SH02", targetDurationSeconds: 8 },
    { shotId: "S01E01_SC02_SH03", targetDurationSeconds: 8 },
  ];

  it("regenerates ONLY the affected shot and keeps every other shot", () => {
    const plan = buildRepairPlan(episode(shots, "S01E01_SC01_SH02"));
    expect(plan.scope).toBe("single-shot");
    expect(plan.decisions).toHaveLength(3);
    const failed = plan.decisions.find((d) => d.shotId === "S01E01_SC01_SH02");
    expect(failed?.action).toBe("regenerate");
    expect(failed?.routeId).toBe("agnes-flash");
    expect(failed?.attempt).toBe(1);
    const others = plan.decisions.filter((d) => d.shotId !== "S01E01_SC01_SH02");
    expect(others).toHaveLength(2);
    for (const other of others) {
      expect(other.action).toBe("keep");
      expect(other.routeId).toBeNull();
    }
  });

  it("never emits an episode-wide regeneration: no regenerate action outside the failed shot", () => {
    const manyShots: ShotContext[] = Array.from({ length: 24 }, (_, i) => ({
      shotId: `S01E01_SC05_SH${String(i + 1).padStart(2, "0")}`,
      targetDurationSeconds: 6,
    }));
    const plan = buildRepairPlan(episode(manyShots, "S01E01_SC05_SH17"));
    const regenerated = plan.decisions.filter((d) => d.action === "regenerate");
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]?.shotId).toBe("S01E01_SC05_SH17");
  });

  it("keeps unaffected shots intact even when the failed shot goes to review", () => {
    const plan = buildRepairPlan({
      ...episode(shots, "S01E01_SC02_SH03"),
      history: history("S01E01_SC02_SH03", "agnes-flash", 5),
    });
    const failed = plan.decisions.find((d) => d.shotId === "S01E01_SC02_SH03");
    expect(failed?.action).toBe("review");
    for (const d of plan.decisions) {
      if (d.shotId !== "S01E01_SC02_SH03") expect(d.action).toBe("keep");
    }
  });

  it("throws when failedShotId is not part of the episode (no silent whole-episode fallback)", () => {
    expect(() => buildRepairPlan(episode(shots, "S01E01_SC09_SH99"))).toThrow(RetryError);
  });

  it("throws on empty shot list and blank episode id", () => {
    expect(() => buildRepairPlan(episode([], "S01E01_SC01_SH01"))).toThrow(RetryError);
    expect(() => buildRepairPlan({ ...episode(shots, "S01E01_SC01_SH01"), episodeId: "  " })).toThrow(
      RetryError,
    );
  });
});

describe("buildRepairPlan — ladder escalation (spec §13)", () => {
  const shot = { shotId: "S01E01_SC01_SH01", targetDurationSeconds: 8 };

  it("starts on the Agnes Flash route with attempt 1", () => {
    const plan = buildRepairPlan(episode([shot], shot.shotId));
    const d = plan.decisions[0];
    expect(d?.action).toBe("regenerate");
    expect(d?.routeId).toBe("agnes-flash");
    expect(d?.attempt).toBe(1);
  });

  it("allows one Flash retry (attempt 2) after the first Flash attempt", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      history: history(shot.shotId, "agnes-flash", 1),
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("regenerate");
    expect(d?.routeId).toBe("agnes-flash");
    expect(d?.attempt).toBe(2);
  });

  it("escalates to Agnes regular when Flash attempts are exhausted", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      history: history(shot.shotId, "agnes-flash", 2),
    });
    const d = plan.decisions[0];
    expect(d?.routeId).toBe("agnes-regular");
    expect(d?.attempt).toBe(1);
  });

  it("escalates to Seedance after Agnes regular is exhausted", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      history: [
        ...history(shot.shotId, "agnes-flash", 2),
        ...history(shot.shotId, "agnes-regular", 1),
      ],
    });
    expect(plan.decisions[0]?.routeId).toBe("seedance");
  });

  it("enters human REVIEW when all automated routes are exhausted (standard ladder)", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      history: [
        ...history(shot.shotId, "agnes-flash", 2),
        ...history(shot.shotId, "agnes-regular", 1),
        ...history(shot.shotId, "seedance", 1),
      ],
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("review");
    expect(d?.routeId).toBeNull();
    expect(d?.reason).toContain("human review");
  });

  it("gives hero/complex/long/action shots the Wan route; standard shots never get it", () => {
    for (const tag of ["hero", "complex", "long", "action"] as const) {
      const wanShot: ShotContext = { shotId: "S01E01_SC03_SH09", tags: [tag] };
      const plan = buildRepairPlan({
        ...episode([wanShot], wanShot.shotId),
        history: [
          ...history(wanShot.shotId, "agnes-flash", 2),
          ...history(wanShot.shotId, "agnes-regular", 1),
          ...history(wanShot.shotId, "seedance", 1),
        ],
      });
      expect(plan.decisions[0]?.action).toBe("regenerate");
      expect(plan.decisions[0]?.routeId).toBe("wan");
    }
    const plain: ShotContext = { shotId: "S01E01_SC03_SH09" };
    const plan = buildRepairPlan({
      ...episode([plain], plain.shotId),
      history: [
        ...history(plain.shotId, "agnes-flash", 2),
        ...history(plain.shotId, "agnes-regular", 1),
        ...history(plain.shotId, "seedance", 1),
      ],
    });
    expect(plan.decisions[0]?.action).toBe("review");
  });

  it("caps total attempts across all routes (maxTotalAttempts) and falls to review", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      policy: { maxTotalAttempts: 3 },
      history: [
        ...history(shot.shotId, "agnes-flash", 2),
        ...history(shot.shotId, "agnes-regular", 1),
      ],
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("review");
    expect(d?.reason).toContain("3/3");
  });

  it("history for OTHER shots never consumes this shot's retry budget", () => {
    const other = history("S01E01_SC01_SH02", "agnes-flash", 2);
    const plan = buildRepairPlan({ ...episode([shot], shot.shotId), history: other });
    expect(plan.decisions[0]?.routeId).toBe("agnes-flash");
    expect(plan.decisions[0]?.attempt).toBe(1);
  });
});

describe("buildRepairPlan — cost policy bounding (spec §4/§13)", () => {
  const shot = { shotId: "S01E01_SC01_SH01", targetDurationSeconds: 8 };

  it("blocks regeneration when the spend gate denies the attempt", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      spendGate: denyGate("cumulative projected spend $25.10 crosses the $25.00 auto limit"),
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("awaiting-approval");
    expect(d?.routeId).toBeNull();
    expect(d?.reason).toContain("spend policy");
    expect(d?.reason).toContain("$25.10");
  });

  it("never auto-runs a regeneration with UNKNOWN cost (fail closed)", () => {
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      costEstimator: flatEstimator(null),
      spendGate: {
        canSpend: (cost) => (cost === null ? { allowed: false, reason: "unknown cost" } : { allowed: true }),
      },
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("awaiting-approval");
    expect(d?.reason).toContain("unknown cost");
  });

  it("auto-runs when the gate approves the estimated cost", () => {
    const seen: Array<number | null> = [];
    const plan = buildRepairPlan({
      ...episode([shot], shot.shotId),
      costEstimator: {
        estimateCost: ({ routeId, durationSeconds }) =>
          routeId === "agnes-flash" ? (durationSeconds ?? 0) * 0.02 : 0.05 * (durationSeconds ?? 0),
      },
      spendGate: {
        canSpend: (cost) => {
          seen.push(cost);
          return cost !== null && cost < 0.2 ? { allowed: true } : { allowed: false, reason: "too expensive" };
        },
      },
    });
    expect(plan.decisions[0]?.action).toBe("regenerate");
    expect(seen[0]).toBeCloseTo(0.16);
  });

  it("passes the shot's target duration to the estimator", () => {
    const durations: Array<number | null> = [];
    buildRepairPlan({
      ...episode([shot], shot.shotId),
      costEstimator: {
        estimateCost: ({ durationSeconds }) => {
          durations.push(durationSeconds);
          return 0.1;
        },
      },
    });
    expect(durations).toEqual([8]);
  });

  it("passes null duration for shots with unknown duration", () => {
    const durations: Array<number | null> = [];
    buildRepairPlan({
      ...episode([{ shotId: "SH1" }], "SH1"),
      costEstimator: {
        estimateCost: ({ durationSeconds }) => {
          durations.push(durationSeconds);
          return 0.1;
        },
      },
    });
    expect(durations).toEqual([null]);
  });

  it("keeps awaiting-approval scoped to the failed shot — others stay keep", () => {
    const shots: ShotContext[] = [
      { shotId: "A" },
      { shotId: "B" },
    ];
    const plan = buildRepairPlan({
      ...episode(shots, "B"),
      spendGate: denyGate("over budget"),
    });
    expect(plan.scope).toBe("single-shot");
    expect(plan.decisions.find((d) => d.shotId === "A")?.action).toBe("keep");
    expect(plan.decisions.find((d) => d.shotId === "B")?.action).toBe("awaiting-approval");
  });
});

describe("policy resolution and helpers", () => {
  it("default policy mirrors spec §13 ladder", () => {
    expect(DEFAULT_RETRY_POLICY.ladder.standard).toEqual([
      "agnes-flash",
      "agnes-regular",
      "seedance",
      "review",
    ]);
    expect(DEFAULT_RETRY_POLICY.ladder.wanEligible).toEqual([
      "agnes-flash",
      "agnes-regular",
      "seedance",
      "wan",
      "review",
    ]);
  });

  it("resolvePolicy merges partial overrides without mutating the default", () => {
    const policy = resolvePolicy({ maxTotalAttempts: 2, maxAttemptsPerRoute: { "agnes-flash": 1 } });
    expect(policy.maxTotalAttempts).toBe(2);
    expect(policy.maxAttemptsPerRoute["agnes-flash"]).toBe(1);
    expect(DEFAULT_RETRY_POLICY.maxTotalAttempts).toBe(5);
    expect(DEFAULT_RETRY_POLICY.maxAttemptsPerRoute["agnes-flash"]).toBe(2);
  });

  it("counts attempts per shot+route from history", () => {
    const h = [
      ...history("A", "agnes-flash", 2),
      ...history("A", "seedance", 1),
      ...history("B", "agnes-flash", 1),
    ];
    expect(attemptsUsedOnRoute(h, "A", "agnes-flash")).toBe(2);
    expect(attemptsUsedOnRoute(h, "A", "seedance")).toBe(1);
    expect(attemptsUsedOnRoute(h, "A", "wan")).toBe(0);
    expect(attemptsUsedOnRoute(h, "B", "agnes-flash")).toBe(1);
  });

  it("detects Wan eligibility from tags", () => {
    expect(isWanEligible({ shotId: "S", tags: ["hero"] })).toBe(true);
    expect(isWanEligible({ shotId: "S", tags: ["custom", "action"] })).toBe(true);
    expect(isWanEligible({ shotId: "S", tags: ["custom"] })).toBe(false);
    expect(isWanEligible({ shotId: "S" })).toBe(false);
  });

  it("handles empty history when checking attempts on route", () => {
    expect(attemptsUsedOnRoute([], "SHOT_01", "agnes-flash")).toBe(0);
  });

  it("handles empty ladder gracefully by falling back to human review", () => {
    const singleShot: ShotContext = { shotId: "SHOT_01", targetDurationSeconds: 6 };
    const plan = buildRepairPlan({
      ...episode([singleShot], singleShot.shotId),
      policy: {
        ladder: { standard: [], wanEligible: [] },
      },
    });
    const d = plan.decisions[0];
    expect(d?.action).toBe("review");
    expect(d?.routeId).toBeNull();
  });
});