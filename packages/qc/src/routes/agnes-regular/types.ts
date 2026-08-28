/**
 * QC-008 — Agnes regular fallback route: types.
 *
 * The route owns the decision "Flash FAIL after retry → escalate to Agnes
 * Video 2.5 regular" (spec §13, §20; runbook §24 QC/routing). It consumes a
 * QC verdict produced for an Agnes Flash attempt (QC-007 owns producing that
 * verdict; QC-001 owns the canonical QC result schema — this module keeps a
 * minimal input surface so the route stays decoupled until those merge).
 *
 * The route only decides. It never submits, never polls, never touches
 * money. Escalation pushes the shot to the next tier (Seedance QC-009 when
 * an identity/reference problem remains, Wan QC-010 for hero/complex/long
 * shots, human REVIEW QC-011 when automated routes exhaust).
 */

/** Shot classes that bias routing away from a cheap escalated retry (spec §13). */
export type ShotClass =
  | "standard"
  | "hero"
  | "complex"
  | "action"
  | "long";

/** QC verdict for a single generated attempt (subset of the QC result). */
export type QcVerdict = "PASS" | "FAIL";

/**
 * Keyframe strategy carried by the shot spec record (spec §12
 * `keyframe_strategy`). Maps to Agnes generation modes.
 */
export type KeyframeStrategy =
  | "first-frame"
  | "first-last-frame"
  | "reference-only"
  | "none";

/** Reference asset inputs available for the shot. */
export interface ShotReferenceAssets {
  /** Canonical image asset paths/URLs (identity, wardrobe, location refs). */
  images?: string[];
  /** Reference video paths/URLs (regular tier supports these; Flash rejects). */
  videos?: string[];
  /** Reference audio paths/URLs. */
  audios?: string[];
}

/** The minimal shot information the route needs to plan an escalation. */
export interface ShotFallbackInput {
  shotId: string;
  sceneId?: string;
  /** Planned shot duration in seconds (spec §12 `target_duration`). */
  targetDurationSeconds: number;
  shotClass?: ShotClass;
  keyframeStrategy?: KeyframeStrategy;
  referenceAssets?: ShotReferenceAssets;
}

/**
 * Outcome of the Flash attempt that went through automated QC. This is the
 * trigger input for the fallback decision.
 */
export interface FlashAttemptOutcome {
  shot: ShotFallbackInput;
  /** Provider that produced the attempt. */
  provider: "agnes";
  /** Model id attempted; must be the Flash model to match this route. */
  modelId: string;
  qcVerdict: QcVerdict;
  /** Flash retries already consumed (QC-007 owns doing them). */
  retryCount: number;
  /**
   * True when QC-007 bypassed the Flash retry because the failure class
   * (identity/reference, provider/transport) cannot be fixed by a seed
   * re-roll — the shot escalates without a consumed retry (QC-007 hop
   * contract). Absent/false means the retry must be exhausted first.
   */
  retryBypassed?: boolean;
  /** Reasons the verdict failed (diagnostic; not decision input). */
  qcReasons?: string[];
  /**
   * Previously attempted model ids for this shot (idempotency guard: never
   * re-escalate a shot that already used Agnes regular).
   */
  priorModelIds?: string[];
  /** Remaining spend allowance in USD; undefined = no budget gate. */
  remainingBudgetUsd?: number;
}

/** Agnes generation mode selected from the shot's strategy/references. */
export type AgnesRegularMode =
  | "text"
  | "keyframe"
  | "reference";

/** Resolution tiers accepted by Agnes Video 2.5 regex. */
export type AgnesRegularSize = "720P" | "960P" | "2K";

/**
 * Verified model ids and documented limits (CAP-002 seed,
 * packages/capability-registry/src/data/agnes.ts, docs verified 2026-08-28).
 * The stale `agnes-video-v2.0` public-docs id never routes here.
 */
export const AGNES_REGULAR_MODEL_ID = "agnes-video-2.5" as const;
export const AGNES_VIDEO_2_5_FLASH_MODEL_ID = "agnes-video-2.5-flash" as const;

/** Documented output size tiers for Agnes Video 2.5 regular. */
export const AGNES_REGULAR_SIZE_TIERS = ["720P", "960P", "2K"] as const;

/** List price per output second by size tier (pricing doc, verified 2026-08-28). */
export const AGNES_REGULAR_USD_PER_SECOND_BY_SIZE: Readonly<
  Record<AgnesRegularSize, number>
> = Object.freeze({
  "720P": 0.025,
  "960P": 0.04,
  "2K": 0.055,
});

/** Default output tier (matches the Flash tier default). */
export const DEFAULT_REGULAR_SIZE: AgnesRegularSize = "720P";

/** Documented duration range — `seconds` is the string "4"–"12". */
export const MIN_DURATION_SECONDS = 4;
export const MAX_DURATION_SECONDS = 12;

/**
 * Escalation decision. Either escalate to Agnes Video 2.5 regular with a
 * mode-validated request plan, or decline with the concrete reason so the
 * router can move to the next tier.
 */
export type AgnesRegularFallbackDecision =
  | {
      action: "escalate-to-agnes-regular";
      reason: "flash-failed-after-retry";
      request: AgnesRegularEscalationRequest;
    }
  | {
      action: "no-escalation";
      reason:
        | "flash-passed"
        | "flash-retry-not-exhausted"
        | "flash-model-mismatch"
        | "already-escalated-to-regular"
        | "budget-exhausted"
        | "hero-complex-or-long-shot"
        | "duration-unsupported-by-agnes-regular"
        | "conflicting-keyframe-and-references";
    };

/**
 * The validated plan for an Agnes Video 2.5 regular call. Mode rules honored
 * per the verified capability profile (CAP-002, docs verified 2026-08-28):
 * mode=keyframe excludes images/audios/videos, mode=reference excludes
 * first_frame/last_frame.
 */
export interface AgnesRegularEscalationRequest {
  provider: "agnes";
  modelId: string;
  mode: AgnesRegularMode;
  /** Output size tier; default 720P like the Flash tier. */
  size: AgnesRegularSize;
  /** Output seconds as a string (Agnes accepts "4"–"12"). */
  seconds: string;
  /** Keyframe payload when mode=keyframe. */
  keyframes?: {
    firstFrameUrl?: string;
    lastFrameUrl?: string;
  };
  /** Reference payload when mode=reference. */
  references?: {
    images?: string[];
    videos?: string[];
    audios?: string[];
  };
  /** Monotonic attempt counter baked into the plan (audit/idempotency). */
  attemptNumber: number;
}
