/**
 * Wan hero/complex fallback route — types (QC-010).
 *
 * The route is provider-shaped but provider-DECOUPLED: it consumes and
 * produces structural types that match the verified Wan 3.0 adapter
 * (packages/providers/src/kie/wan — KIE-005) without importing it, so the
 * packages compose structurally once KIE-005 merges. Shot input mirrors the
 * provider-independent Shot Specification Record (spec §12).
 */

/** Output resolutions verified for Wan 3.0 (capability registry, 2026-08-28). */
export type WanResolution = "480P" | "720P" | "1080P";

/** Verified Wan 3.0 model slugs (Kie createTask `model` field). */
export type WanRouteModelId = "wan/3-0-video" | "wan/3-0-video-prime";

/**
 * The subset of the Wan 3.0 wire input this route can produce. Field names
 * and semantics match KIE-005's `WanVideoInput` exactly (structural twin).
 */
export interface WanRouteVideoInput {
  prompt: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  resolution?: WanResolution;
  duration?: number;
  audio?: boolean;
  seed?: number;
}

/**
 * Provider-independent shot facts the policy needs. Story/text fields are
 * DATA: the policy only reads declared flags and numbers — it never parses
 * or executes prose (untrusted story text, runbook §13).
 */
export interface WanRouteShot {
  shotId: string;
  /** Planner-declared hero shot (spec §13: hero → Wan). */
  hero?: boolean;
  /** Planner-declared action-heavy shot (spec §13: action → Wan). */
  action?: boolean;
  /** Planner-declared complexity tier. Default "standard". */
  complexity?: "low" | "standard" | "complex";
  /** Planned clip length in seconds (spec §12 `target_duration`). */
  targetDurationSeconds: number;
  /** Compiled prompt + character count from the budget manager (spec §23). */
  compiledPrompt: string;
  compiledPromptCharacters: number;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  /** Caller-declared total seconds of the reference videos (billing cross-check). */
  referenceVideoSeconds?: number;
}

/** One prior generation attempt for this shot (spec §13 "quality history"). */
export interface WanRouteAttempt {
  /** Route tier id: "agnes-flash" | "agnes-regular" | "seedance" | "wan". */
  provider: string;
  outcome: "pass" | "fail";
  /** QC failure class when outcome is "fail" (e.g. "identity", "reference", "prompt_seed"). */
  failureClass?: string;
}

/** Spend/quota state from the cost engine (spec §33). */
export interface WanSpendState {
  /** Cumulative paid spend so far, USD. */
  cumulativeUsd: number;
  /** User-approved spend ceiling. Default AUTO_SPEND_LIMIT_USD = 25.00. */
  approvedCeilingUsd: number;
  /** Remaining included quota for this provider, in seconds (when tracked). */
  remainingQuotaSeconds?: number;
}

export interface WanRouteContext {
  qualityHistory: WanRouteAttempt[];
  spend: WanSpendState;
  /** Prefer the high-speed prime variant when true (default: standard). */
  preferFastModel?: boolean;
}

/** One machine-readable justification line on a decision. */
export interface WanPolicyReason {
  code: string;
  detail: string;
}

/**
 * Policy outcome. `route` = submit to Wan; `skip` = Wan is wrong for this
 * shot now; `hold` = would route but needs user approval first (spec §33
 * spend gate — reaching/exceeding the ceiling requires approval).
 */
export type WanPolicyDecision =
  | { outcome: "route"; model: WanRouteModelId; resolution: WanResolution; reasons: WanPolicyReason[] }
  | { outcome: "skip"; reasons: WanPolicyReason[] }
  | { outcome: "hold"; reasons: WanPolicyReason[] };

/** Final route result returned to the retry orchestrator (spec §20). */
export type WanRouteResult =
  | {
      status: "submitted";
      shotId: string;
      taskId: string;
      model: WanRouteModelId;
      resolution: WanResolution;
      /** Projected spend of THIS request, USD (verified per-second rates). */
      projectedCostUsd: number;
      reasons: WanPolicyReason[];
      input: WanRouteVideoInput;
    }
  | {
      status: "skipped";
      shotId: string;
      reasons: WanPolicyReason[];
    }
  | {
      status: "held-for-approval";
      shotId: string;
      reasons: WanPolicyReason[];
    };