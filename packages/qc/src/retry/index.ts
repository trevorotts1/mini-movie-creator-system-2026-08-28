/**
 * Retry policy for automated QC repair (runbook §24 QC/routing, spec §13 video
 * router policy, §18 async provider job safety, §20 automated QC + immediate
 * repair, §4 cost/quota engine).
 *
 * Contract:
 * - A QC failure repairs the AFFECTED SHOT ONLY. The module never emits an
 *   episode-wide regeneration decision: `scope` is always `"single-shot"` and
 *   every non-failed shot in the episode is returned as `keep`.
 * - The repair is BOUNDED twice: (1) attempts are capped per route and in
 *   total, and (2) every regeneration attempt must pass an injected spend gate
 *   — a cost-approval or $25-crossing attempt returns `awaiting-approval`
 *   instead of auto-regenerating. Unknown cost is never auto-approved
 *   (fail closed; spec §4/§13: an unestimable request can only ever require
 *   approval, never run as free).
 * - Retry history is passed in (persisted by the caller per spec §18 retry
 *   count / per-job durable record) and consumed read-only; the escalation
 *   ladder steps down when the current route's attempt budget is exhausted.
 *
 * The route-specific fallback tasks (QC-007 agnes-flash, QC-008 agnes-regular,
 * QC-009 seedance, QC-010 wan, QC-011 human-review) implement the individual
 * routes; this module decides WHEN and for WHICH shot, against which route and
 * whether the spend gate lets it run automatically.
 */

/** Shot tags that make a shot Wan-eligible (spec §13: complex/long/hero/action). */
export type ShotTag = "hero" | "complex" | "long" | "action" | (string & {});

/** Route ids of the retry ladder; `review` is the terminal human state (spec §20). */
export type RouteId =
  | "agnes-flash"
  | "agnes-regular"
  | "seedance"
  | "wan"
  | "review";

export const ROUTE_IDS: readonly RouteId[] = [
  "agnes-flash",
  "agnes-regular",
  "seedance",
  "wan",
  "review",
];

/** Escalation ladder configuration per shot class (spec §13 default shown). */
export interface RetryLadder {
  /** Ladder for shots with no hero/complex/long/action tag. */
  standard: readonly RouteId[];
  /** Ladder for hero/complex/long/action shots — includes the Wan route. */
  wanEligible: readonly RouteId[];
}

export interface RetryPolicyConfig {
  ladder: RetryLadder;
  /** Max regeneration attempts allowed per route before descending the ladder. */
  maxAttemptsPerRoute: Readonly<Record<RouteId, number>>;
  /** Hard cap on total regeneration attempts per shot across ALL routes. */
  maxTotalAttempts: number;
}

/**
 * Default policy mirroring spec §13: Flash twice (original + one retry on
 * likely prompt/seed failure) → Agnes regular → Seedance → Wan only for
 * hero/complex/long/action shots → human REVIEW when automated routes exhaust.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  ladder: {
    standard: ["agnes-flash", "agnes-regular", "seedance", "review"],
    wanEligible: ["agnes-flash", "agnes-regular", "seedance", "wan", "review"],
  },
  maxAttemptsPerRoute: {
    "agnes-flash": 2,
    "agnes-regular": 1,
    seedance: 1,
    wan: 1,
    review: Number.POSITIVE_INFINITY,
  },
  maxTotalAttempts: 5,
};

/** One recorded regeneration attempt (persisted per spec §18 retry count). */
export interface RetryHistoryEntry {
  shotId: string;
  routeId: RouteId;
  /** 1-based attempt number of this attempt on its route. */
  attempt: number;
  /** ISO-8601 submission timestamp. */
  at: string;
  /** Paid cost of this attempt if known; null = unknown, never guessed. */
  cost: number | null;
}

/** Per-shot input for a repair decision. */
export interface ShotContext {
  shotId: string;
  /** Wan-eligibility tags (spec §13). Empty/absent = standard class. */
  tags?: readonly ShotTag[];
  /** Target duration used for cost estimation; null = unknown. */
  targetDurationSeconds?: number | null;
}

/** Estimates the paid cost of one regeneration attempt; null = unknown. */
export interface RetryCostEstimator {
  estimateCost(request: {
    shotId: string;
    routeId: RouteId;
    durationSeconds: number | null;
  }): number | null;
}

/**
 * Spend gate enforcing the cost/approval policy (spec §4, §13 user-approved
 * spend ceiling, runbook §33). Implementations may be stateful to account for
 * cumulative spend across attempts. Unknown (`null`) cost must be rejected
 * here — the decision to reject is the gate's, the retry engine only honors it.
 */
export interface SpendGate {
  canSpend(
    cost: number | null,
  ): { allowed: true } | { allowed: false; reason: string };
}

export interface RetryPolicyOverrides {
  ladder?: RetryLadder;
  maxAttemptsPerRoute?: Readonly<Partial<Record<RouteId, number>>>;
  maxTotalAttempts?: number;
}

export interface RepairRequest {
  episodeId: string;
  /** All shots of the episode — any shot other than the failed one is keep. */
  shots: readonly ShotContext[];
  /** The single shot the QC failure is about. */
  failedShotId: string;
  /** Prior retry history for the failed shot (read-only, may be empty). */
  history: readonly RetryHistoryEntry[];
  policy?: RetryPolicyOverrides;
  costEstimator: RetryCostEstimator;
  spendGate: SpendGate;
}

export type RepairAction = "regenerate" | "keep" | "review" | "awaiting-approval";

export interface ShotRepairDecision {
  shotId: string;
  /** `regenerate` on the affected shot only; everyone else is `keep`. */
  action: RepairAction;
  /** Next route for a regenerate decision; always null otherwise. */
  routeId: RouteId | null;
  /** 1-based attempt number on `routeId` for a regenerate decision. */
  attempt: number | null;
  reason: string;
}

export interface RepairPlan {
  /** Scope is immutable: targeted repair of the affected shot, never whole-episode. */
  scope: "single-shot";
  episodeId: string;
  decisions: readonly ShotRepairDecision[];
}

export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryError";
  }
}

/** Merge a partial policy over the defaults, field by field. */
export function resolvePolicy(overrides?: RetryPolicyOverrides): RetryPolicyConfig {
  const base = DEFAULT_RETRY_POLICY;
  const maxAttemptsPerRoute: Record<RouteId, number> = { ...base.maxAttemptsPerRoute };
  if (overrides?.maxAttemptsPerRoute) {
    for (const route of ROUTE_IDS) {
      const value = overrides.maxAttemptsPerRoute[route];
      if (value !== undefined) maxAttemptsPerRoute[route] = value;
    }
  }
  return {
    ladder: overrides?.ladder ?? base.ladder,
    maxAttemptsPerRoute,
    maxTotalAttempts: overrides?.maxTotalAttempts ?? base.maxTotalAttempts,
  };
}

/** Attempts already used on one route, from history entries for this shot. */
export function attemptsUsedOnRoute(
  history: readonly RetryHistoryEntry[],
  shotId: string,
  routeId: RouteId,
): number {
  return history.reduce(
    (count, entry) => (entry.shotId === shotId && entry.routeId === routeId ? count + 1 : count),
    0,
  );
}

/** True when the shot carries any Wan-eligibility tag (spec §13). */
export function isWanEligible(shot: ShotContext): boolean {
  return (shot.tags ?? []).some((tag) => tag === "hero" || tag === "complex" || tag === "long" || tag === "action");
}

/**
 * Build the repair plan for one failed shot.
 *
 * Throws RetryError when the episode id is blank, the shot list is empty, or
 * `failedShotId` is not among the episode shots — an unknown shot must never
 * silently degrade into a whole-episode plan.
 */
export function buildRepairPlan(request: RepairRequest): RepairPlan {
  if (request.episodeId.trim() === "") {
    throw new RetryError("episodeId is required");
  }
  if (request.shots.length === 0) {
    throw new RetryError("episode shot list is empty");
  }
  const targets = new Set(request.shots.map((shot) => shot.shotId));
  if (!targets.has(request.failedShotId)) {
    throw new RetryError(
      `failedShotId ${JSON.stringify(request.failedShotId)} is not a shot of this episode`,
    );
  }

  const policy = resolvePolicy(request.policy);
  const failed = request.shots.find((shot) => shot.shotId === request.failedShotId);
  if (failed === undefined) {
    // Unreachable: the set check above guarantees the find succeeds.
    throw new RetryError(`failedShotId ${JSON.stringify(request.failedShotId)} not found`);
  }

  const failedDecision = decideFailedShot(failed, request.history, policy, request);
  const decisions: ShotRepairDecision[] = [];
  for (const shot of request.shots) {
    if (shot.shotId === request.failedShotId) {
      decisions.push(failedDecision);
    } else {
      decisions.push({
        shotId: shot.shotId,
        action: "keep",
        routeId: null,
        attempt: null,
        reason: "not the affected shot — kept as-is; never regenerate unaffected shots",
      });
    }
  }

  return { scope: "single-shot", episodeId: request.episodeId, decisions };
}

function decideFailedShot(
  shot: ShotContext,
  history: readonly RetryHistoryEntry[],
  policy: RetryPolicyConfig,
  request: RepairRequest,
): ShotRepairDecision {
  const ladder = isWanEligible(shot) ? policy.ladder.wanEligible : policy.ladder.standard;
  if (history.length >= policy.maxTotalAttempts) {
    return {
      shotId: shot.shotId,
      action: "review",
      routeId: null,
      attempt: null,
      reason: `retry budget exhausted (${history.length}/${policy.maxTotalAttempts} total attempts) — automated routes exhausted, human review`,
    };
  }

  const next = nextLadderStep(shot.shotId, history, ladder, policy);
  if (next === null) {
    return {
      shotId: shot.shotId,
      action: "review",
      routeId: null,
      attempt: null,
      reason: "all automated retry routes exhausted — human review",
    };
  }
  const { routeId, attempt } = next;
  if (routeId === "review") {
    return {
      shotId: shot.shotId,
      action: "review",
      routeId: null,
      attempt: null,
      reason: "automated routes exhausted — human review",
    };
  }

  const cost = request.costEstimator.estimateCost({
    shotId: shot.shotId,
    routeId,
    durationSeconds: shot.targetDurationSeconds ?? null,
  });
  const gate = request.spendGate.canSpend(cost);
  if (!gate.allowed) {
    return {
      shotId: shot.shotId,
      action: "awaiting-approval",
      routeId: null,
      attempt: null,
      reason: `retry on ${routeId} blocked by spend policy: ${gate.reason}`,
    };
  }

  return {
    shotId: shot.shotId,
    action: "regenerate",
    routeId,
    attempt,
    reason: `targeted regeneration of affected shot on ${routeId} (attempt ${attempt})`,
  };
}

/** First ladder step with remaining attempt budget; null = ladder fully spent. */
function nextLadderStep(
  shotId: string,
  history: readonly RetryHistoryEntry[],
  ladder: readonly RouteId[],
  policy: RetryPolicyConfig,
): { routeId: RouteId; attempt: number } | null {
  for (const routeId of ladder) {
    const used = attemptsUsedOnRoute(history, shotId, routeId);
    const cap = policy.maxAttemptsPerRoute[routeId] ?? 0;
    if (used < cap) {
      return { routeId, attempt: used + 1 };
    }
  }
  return null;
}
