/**
 * Wan hero/complex fallback routing policy (QC-010).
 *
 * Spec §13/§27: the last escalation tier — "especially complex/long/hero/
 * action shot: Wan 3.0". NOT rigid: the decision weighs model capabilities
 * (verified Wan limits), shot type, reference needs, quality history (which
 * tier failed and why), projected cost, and remaining quota/spend ceiling.
 *
 * The policy is a pure, table-driven function: every decision carries
 * machine-readable reasons so tests assert the whole table and the retry
 * orchestrator (QC-006) can log exactly why Wan was chosen or skipped.
 * Story prose is never parsed — only declared flags and numbers are read.
 */
import type {
  WanPolicyDecision,
  WanPolicyReason,
  WanResolution,
  WanRouteContext,
  WanRouteModelId,
  WanRouteShot,
} from "./types.js";

/**
 * Capability facts of the verified Wan 3.0 profile (KIE-005, verified
 * 2026-08-28 against docs.kie.ai). Kept as route-local constants so this
 * package never imports @mmcs/providers; both encode the same registry row.
 */
export const WAN_ROUTE_LIMITS = {
  hardMaxPromptCharacters: 20_000,
  maxReferenceImages: 10,
  maxReferenceVideos: 5,
  maxReferenceAudio: 5,
  minDurationSeconds: 2,
  maxDurationSeconds: 30,
  /** Above this planned length the shot is "long" (spec §13) → Wan tier. */
  longShotThresholdSeconds: 12,
  /** Reference-count needs at/above this signal "reference-heavy". */
  referenceHeavyThreshold: 5,
  /** Verified per-output-second USD rates by resolution (standard model). */
  usdPerSecondByResolution: { "480P": 0.04, "720P": 0.08, "1080P": 0.16 } as const,
  /** Verified per-output-second USD rates by resolution (prime high-speed model, KIE-005). */
  usdPerSecondByResolutionPrime: { "480P": 0.0612, "720P": 0.126, "1080P": 0.252 } as const,
  /** Default spec §33 spend gate. */
  defaultApprovedCeilingUsd: 25.0,
} as const;

/** Shot traits that qualify for the Wan tier (spec §13 list). */
export type WanShotTrait =
  | "hero"
  | "action"
  | "complex"
  | "long"
  | "quality_history_escalation"
  | "reference_heavy";

/** One row of the routing policy table: trigger → model/resolution. */
export interface WanPolicyTableRow {
  id: string;
  /** Which trait this row handles. */
  trait: WanShotTrait;
  model: WanRouteModelId;
  resolution: WanResolution;
  /** Human-readable row description (doc + assertion label). */
  description: string;
}

/**
 * The policy table. Rows are evaluated top-down; the first matching row
 * wins. Long/complex/reference-heavy shots get 1080P (Wan's strength);
 * quality-history escalations keep 1080P too but are documented separately
 * so QC can tell a planner-declared escalation from a failure-driven one.
 */
export const WAN_POLICY_TABLE: readonly WanPolicyTableRow[] = Object.freeze([
  {
    id: "hero",
    trait: "hero",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Hero shot → Wan 3.0 standard at 1080P",
  },
  {
    id: "action",
    trait: "action",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Action shot → Wan 3.0 standard at 1080P",
  },
  {
    id: "complex",
    trait: "complex",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Complex shot → Wan 3.0 standard at 1080P",
  },
  {
    id: "long",
    trait: "long",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Long shot (target > 12s) → Wan 3.0 standard at 1080P",
  },
  {
    id: "reference_heavy",
    trait: "reference_heavy",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Reference-heavy shot (>= 5 refs) → Wan 3.0 standard at 1080P (10-ref ceiling)",
  },
  {
    id: "quality_history_escalation",
    trait: "quality_history_escalation",
    model: "wan/3-0-video",
    resolution: "1080P",
    description: "Prior tiers exhausted (identity/reference problem persists) → Wan 3.0 at 1080P",
  },
]);

/** All hard gates the policy enforces BEFORE any table row is considered. */
export interface WanPolicyGate {
  id: string;
  /**
   * What a gate failure means: "skip" = Wan is wrong for this shot
   * (capability); "hold" = Wan is right but needs user approval first
   * (spend ceiling, spec §33).
   */
  onFailure: "skip" | "hold";
  /** Returns a failure reason when the gate fails, else null. */
  check: (shot: WanRouteShot, context: WanRouteContext) => WanPolicyReason | null;
}

/**
 * Capability gate: the shot must FIT Wan's verified limits (spec §5/§6 —
 * reject over-limit requests before the provider call, never inside it).
 */
export const WAN_CAPABILITY_GATE: WanPolicyGate = {
  id: "capability",
  onFailure: "skip",
  check: (shot) => {
    if (shot.compiledPromptCharacters > WAN_ROUTE_LIMITS.hardMaxPromptCharacters) {
      return {
        code: "prompt_over_limit",
        detail: `compiled prompt is ${shot.compiledPromptCharacters} chars > Wan hard max ${WAN_ROUTE_LIMITS.hardMaxPromptCharacters}; compress via the budget manager (spec §23) before routing`,
      };
    }
    const images = shot.referenceImageUrls?.length ?? 0;
    if (images > WAN_ROUTE_LIMITS.maxReferenceImages) {
      return {
        code: "too_many_reference_images",
        detail: `${images} reference images > Wan max ${WAN_ROUTE_LIMITS.maxReferenceImages}; trim the reference plan`,
      };
    }
    const videos = shot.referenceVideoUrls?.length ?? 0;
    if (videos > WAN_ROUTE_LIMITS.maxReferenceVideos) {
      return {
        code: "too_many_reference_videos",
        detail: `${videos} reference videos > Wan max ${WAN_ROUTE_LIMITS.maxReferenceVideos}`,
      };
    }
    const audio = shot.referenceAudioUrls?.length ?? 0;
    if (audio > WAN_ROUTE_LIMITS.maxReferenceAudio) {
      return {
        code: "too_many_reference_audio",
        detail: `${audio} reference audio clips > Wan max ${WAN_ROUTE_LIMITS.maxReferenceAudio}`,
      };
    }
    if (shot.targetDurationSeconds > WAN_ROUTE_LIMITS.maxDurationSeconds) {
      return {
        code: "duration_over_limit",
        detail: `target duration ${shot.targetDurationSeconds}s > Wan max ${WAN_ROUTE_LIMITS.maxDurationSeconds}s; split the shot`,
      };
    }
    // -1 is the verified "model decides" sentinel (KIE-005): not a violation.
    if (shot.targetDurationSeconds !== -1 && shot.targetDurationSeconds < WAN_ROUTE_LIMITS.minDurationSeconds) {
      return {
        code: "duration_under_limit",
        detail: `target duration ${shot.targetDurationSeconds}s < Wan min ${WAN_ROUTE_LIMITS.minDurationSeconds}s`,
      };
    }
    const refVideoSeconds = shot.referenceVideoSeconds ?? 0;
    if (refVideoSeconds > 0 && shot.targetDurationSeconds >= 0) {
      const window = refVideoSeconds + shot.targetDurationSeconds;
      if (window > WAN_ROUTE_LIMITS.maxDurationSeconds) {
        return {
          code: "reference_video_duration_over_limit",
          detail: `reference video ${refVideoSeconds}s + output ${shot.targetDurationSeconds}s = ${window}s > Wan max ${WAN_ROUTE_LIMITS.maxDurationSeconds}s (input+output billing window, KIE-005); trim the reference video or shorten the shot`,
        };
      }
    }
    return null;
  },
};

/**
 * Spend gate (spec §4): a request whose projection reaches/exceeds the
 * user-approved ceiling cannot auto-proceed — it HOLDS for approval. The
 * projection uses the row's resolution rate × planned output seconds plus
 * reference-video input seconds (Kie bills input + output), at the chosen
 * model's verified rate. Included quota covers the projection first (spec §4:
 * included quota is never counted as paid spend) — a fully quota-covered
 * request does not gate. Cumulative state is read, never written, here.
 */
export const WAN_SPEND_GATE: WanPolicyGate = {
  id: "spend",
  onFailure: "hold",
  check: (shot, context) => {
    const projection = projectWanSpendUsd(shot, "1080P", context.preferFastModel === true);
    if (projection === null) return null; // model-chosen duration: unknown until submit
    // Included quota covers billable seconds (input video + output, all at the
    // same per-second rate) before paid spend accrues (spec §4: included quota
    // is never counted as paid spend).
    const quotaSeconds = Math.max(context.spend.remainingQuotaSeconds ?? 0, 0);
    const paidSeconds = Math.max(projection.billableSeconds - quotaSeconds, 0);
    if (paidSeconds <= 0) return null; // fully quota-covered: no paid spend, no gate
    const paidUsd = round4(projection.totalUsd * (paidSeconds / projection.billableSeconds));
    const ceiling = context.spend.approvedCeilingUsd ?? WAN_ROUTE_LIMITS.defaultApprovedCeilingUsd;
    const cumulative = context.spend.cumulativeUsd ?? 0;
    if (cumulative + paidUsd >= ceiling) {
      return {
        code: "spend_ceiling",
        detail: `cumulative $${cumulative.toFixed(2)} + projected paid $${paidUsd.toFixed(2)} reaches/exceeds the approved ceiling $${ceiling.toFixed(2)} — user approval required (spec §4)`,
      };
    }
    return null;
  },
};

/** Gates run in order; first failure wins. */
export const WAN_POLICY_GATES: readonly WanPolicyGate[] = Object.freeze([
  WAN_CAPABILITY_GATE,
  WAN_SPEND_GATE,
]);

/** Classify a shot into its qualifying planner-declared traits (may be several). */
export function classifyWanShot(shot: WanRouteShot): WanShotTrait[] {
  const traits: WanShotTrait[] = [];
  if (shot.hero === true) traits.push("hero");
  if (shot.action === true) traits.push("action");
  if (shot.complexity === "complex") traits.push("complex");
  if (shot.targetDurationSeconds > WAN_ROUTE_LIMITS.longShotThresholdSeconds) traits.push("long");
  const refCount =
    (shot.referenceImageUrls?.length ?? 0) +
    (shot.referenceVideoUrls?.length ?? 0) +
    (shot.referenceAudioUrls?.length ?? 0);
  if (refCount >= WAN_ROUTE_LIMITS.referenceHeavyThreshold) traits.push("reference_heavy");
  return traits;
}

/**
 * Quality-history signal: the earlier tiers (Agnes Flash acceptance route,
 * Agnes regular fallback, Seedance fallback) all failed (spec §20 retry
 * chain). Any pass resets the signal; zero attempts means never tried.
 */
export function priorTiersExhausted(history: WanRouteContext["qualityHistory"]): boolean {
  const relevant = history.filter(
    (a) => a.provider === "agnes-flash" || a.provider === "agnes-regular" || a.provider === "seedance",
  );
  if (relevant.length === 0) return false;
  return relevant.every((a) => a.outcome === "fail");
}

/**
 * Projected spend of one Wan request at the given resolution, USD.
 *
 * Kie bills (input video duration + output duration) × per-second rate
 * (capability registry KIE-005 notes.billing). Input video seconds are
 * caller-declared (`referenceVideoSeconds`, billing cross-check); output
 * seconds are the planned target duration. Null when the duration is
 * model-chosen (-1) and no reference-video input pins a minimum.
 */
export function projectWanSpendUsd(
  shot: WanRouteShot,
  resolution: WanResolution,
  prime = false,
): {
  totalUsd: number;
  billableSeconds: number;
} | null {
  const duration = shot.targetDurationSeconds;
  const inputSeconds = Math.max(shot.referenceVideoSeconds ?? 0, 0);
  if (!Number.isFinite(duration)) return null;
  if (duration < 0) return null; // model-chosen duration: unknown until submit
  const rateTable = prime
    ? WAN_ROUTE_LIMITS.usdPerSecondByResolutionPrime
    : WAN_ROUTE_LIMITS.usdPerSecondByResolution;
  const perSecond = rateTable[resolution];
  const billableSeconds = inputSeconds + duration;
  return { totalUsd: round4(perSecond * billableSeconds), billableSeconds };
}

/**
 * Evaluate the policy table for one shot.
 *
 * Order: hard gates first (capability → spend), then the table top-down.
 * `preferFastModel` swaps the row model to the verified prime variant
 * (same limits, faster; ~26% different effective rate) without changing
 * triggers. A quality-history escalation with NO other qualifying trait is
 * still routed — the escalation is itself a qualifying trait (spec §20).
 */
export function evaluateWanPolicy(
  shot: WanRouteShot,
  context: WanRouteContext,
): WanPolicyDecision {
  for (const gate of WAN_POLICY_GATES) {
    const failure = gate.check(shot, context);
    if (failure) return { outcome: gate.onFailure, reasons: [failure] };
  }

  const escalation = priorTiersExhausted(context.qualityHistory);
  const traits = classifyWanShot(shot);
  if (escalation) traits.push("quality_history_escalation");

  const model: WanRouteModelId = context.preferFastModel === true ? "wan/3-0-video-prime" : "wan/3-0-video";
  const resolution: WanResolution = "1080P";

  if (traits.length === 0) {
    return {
      outcome: "skip",
      reasons: [
        {
          code: "no_qualifying_trait",
          detail:
            "shot is not hero/action/complex/long/reference-heavy and no prior-tier escalation stands — Wan tier not triggered (earlier tiers handle it)",
        },
      ],
    };
  }

  const row: WanPolicyTableRow =
    WAN_POLICY_TABLE.find((r) => r.trait === traits[0]) ?? WAN_POLICY_TABLE[0]!;
  const reasons: WanPolicyReason[] = [
    { code: `policy_row_${row.id}`, detail: row.description },
    {
      code: "traits",
      detail: `qualifying traits: ${traits.join(", ")}`,
    },
    {
      code: "capability_check",
      detail: `verified Wan limits: prompt ${shot.compiledPromptCharacters}/${WAN_ROUTE_LIMITS.hardMaxPromptCharacters} chars; refs img ${shot.referenceImageUrls?.length ?? 0}/${WAN_ROUTE_LIMITS.maxReferenceImages} vid ${shot.referenceVideoUrls?.length ?? 0}/${WAN_ROUTE_LIMITS.maxReferenceVideos} aud ${shot.referenceAudioUrls?.length ?? 0}/${WAN_ROUTE_LIMITS.maxReferenceAudio}; duration ${shot.targetDurationSeconds}/${WAN_ROUTE_LIMITS.maxDurationSeconds}s`,
    },
    {
      code: "quality_history",
      detail: escalation
        ? "prior Agnes Flash/regular + Seedance attempts all failed — escalation signal active"
        : "no blocking prior-tier failure history",
    },
    {
      code: "cost",
      detail: `projected spend $${(projectWanSpendUsd(shot, resolution, model === "wan/3-0-video-prime")?.totalUsd ?? 0).toFixed(2)} at ${resolution} (input video ${(shot.referenceVideoSeconds ?? 0).toFixed(1)}s + output ${shot.targetDurationSeconds}s billed); cumulative $${(context.spend.cumulativeUsd ?? 0).toFixed(2)} / ceiling $${(context.spend.approvedCeilingUsd ?? WAN_ROUTE_LIMITS.defaultApprovedCeilingUsd).toFixed(2)}`,
    },
    {
      code: "quota",
      detail:
        context.spend.remainingQuotaSeconds !== undefined
          ? `${context.spend.remainingQuotaSeconds}s included quota remaining for Wan`
          : "no separate Wan quota tracked (paid spend only)",
    },
  ];

  return { outcome: "route", model, resolution, reasons };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}