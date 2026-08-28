/**
 * QC-008 — Agnes regular fallback route.
 *
 * Escalation trigger (spec §13, §20; runbook §24 "QC-008 Agnes regular
 * fallback"): an Agnes Video 2.5 Flash attempt FAILs automated QC after its
 * single retry (QC-007 consumed the retry) → the shot escalates to Agnes
 * Video 2.5 regular. The route validates the escalation against the
 * capability profile before producing a request plan:
 *
 *  - Trigger: provider=agnes, model=agnes-video-2.5-flash, verdict FAIL,
 *    retryCount ≥ 1 (retry exhausted) OR retryBypassed=true (QC-007 hands
 *    identity/reference and provider/transport failures over without
 *    consuming the retry), regular not already used.
 *  - Declines hero/complex/action/long shots — per spec §13 those continue
 *    to the Wan hero/complex tier, not a bigger Agnes model.
 *  - Idempotency: a shot that already ran agnes-video-2.5 never escalates to
 *    it again (fallback chain never reuses a failed tier).
 *  - Budget: when remaining budget is present it must cover the tier's
 *    worst-case cost (price × duration); otherwise the escalation is
 *    declined as budget-exhausted.
 *  - Mode selection: keyframe strategy → keyframe mode (the shot's images
 *    become the first/last frame payload); reference assets → reference
 *    mode; otherwise text. Video/audio references combined with a keyframe
 *    strategy are rejected pre-flight (one mode per request per the verified
 *    profile; keyframe mode excludes images/audios/videos).
 *  - Constraints verified live 2026-08-28 (CAP-002 seed): duration 4–12 s
 *    (string "4"–"12"), size 720P/960P/2K, reference-mode videos supported
 *    (the Flash tier rejects them). The prompt hard-max is NOT documented —
 *    no length limit is enforced here (UNKNOWN is preserved; never invent).
 */

import {
  AGNES_REGULAR_MODEL_ID,
  AGNES_REGULAR_SIZE_TIERS,
  AGNES_REGULAR_USD_PER_SECOND_BY_SIZE,
  AGNES_VIDEO_2_5_FLASH_MODEL_ID,
  DEFAULT_REGULAR_SIZE,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  type AgnesRegularFallbackDecision,
  type AgnesRegularEscalationRequest,
  type AgnesRegularMode,
  type AgnesRegularSize,
  type FlashAttemptOutcome,
  type ShotClass,
} from "./types.js";

/** Shot classes that skip the Agnes regular tier (spec §13: Wan handles them). */
const WAN_TIER_SHOT_CLASSES: ReadonlySet<ShotClass> = new Set([
  "hero",
  "complex",
  "action",
  "long",
]);

/**
 * Classify the escalation trigger from the Flash attempt outcome.
 * Exported for QC and for the router to log the exact decline reason.
 */
export function evaluateFallbackTrigger(
  outcome: FlashAttemptOutcome,
): AgnesRegularFallbackDecision["reason"] {
  if (outcome.qcVerdict === "PASS") return "flash-passed";
  if (outcome.provider !== "agnes" || outcome.modelId !== AGNES_VIDEO_2_5_FLASH_MODEL_ID) {
    return "flash-model-mismatch";
  }
  if (outcome.retryCount < 1 && !outcome.retryBypassed) {
    return "flash-retry-not-exhausted";
  }
  if ((outcome.priorModelIds ?? []).includes(AGNES_REGULAR_MODEL_ID)) {
    return "already-escalated-to-regular";
  }
  if (outcome.shot.shotClass && WAN_TIER_SHOT_CLASSES.has(outcome.shot.shotClass)) {
    return "hero-complex-or-long-shot";
  }
  if (
    outcome.shot.targetDurationSeconds < MIN_DURATION_SECONDS ||
    outcome.shot.targetDurationSeconds > MAX_DURATION_SECONDS
  ) {
    return "duration-unsupported-by-agnes-regular";
  }
  if (
    outcome.remainingBudgetUsd !== undefined &&
    outcome.remainingBudgetUsd < worstCaseCostUsd(outcome.shot.targetDurationSeconds)
  ) {
    return "budget-exhausted";
  }
  return "flash-failed-after-retry";
}

/**
 * Worst-case Agnes Video 2.5 regular cost for a duration: the 2K tier price
 * is the ceiling across documented size tiers. Data from the pricing doc
 * verified 2026-08-28 ($0.025/720P, $0.040/960P, $0.055/2K per output
 * second). Input-video seconds are not billable here (no ref video is being
 * submitted with the escalation itself), so output seconds is the bound.
 */
export function worstCaseCostUsd(durationSeconds: number): number {
  const maxRate = AGNES_REGULAR_USD_PER_SECOND_BY_SIZE["2K"];
  return roundUsd(maxRate * durationSeconds);
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Pick the generation mode from the shot's keyframe strategy + references.
 * Returns a decline reason when the combination is invalid.
 *
 * A keyframe strategy maps to mode=keyframe and consumes the shot's images as
 * the first/last frame payload — the request carries `keyframes` and no
 * `references` array (mode=keyframe excludes images/audios/videos per the
 * verified profile). Video/audio references combined with a keyframe strategy
 * are rejected pre-flight: they cannot be expressed in one mode.
 */
export function selectEscalationMode(outcome: FlashAttemptOutcome):
  | { mode: AgnesRegularMode }
  | { decline: "conflicting-keyframe-and-references" } {
  const strategy = outcome.shot.keyframeStrategy ?? "none";
  const refs = outcome.shot.referenceAssets ?? {};
  const hasVideoOrAudioRefs =
    (refs.videos?.length ?? 0) > 0 || (refs.audios?.length ?? 0) > 0;

  if (strategy === "first-frame" || strategy === "first-last-frame") {
    if (hasVideoOrAudioRefs) return { decline: "conflicting-keyframe-and-references" };
    return { mode: "keyframe" };
  }
  const hasReferences =
    (refs.images?.length ?? 0) > 0 ||
    hasVideoOrAudioRefs;
  if (hasReferences) return { mode: "reference" };
  return { mode: "text" };
}

/** Clamp a duration to the documented 4–12 s range and stringify for Agnes. */
export function regularSecondsString(durationSeconds: number): string {
  const clamped = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, Math.round(durationSeconds)),
  );
  return String(clamped);
}

/**
 * Decide the Agnes regular escalation for a Flash attempt. Pure function —
 * no I/O, no submission; the caller submits the returned plan (AGN-004
 * video-submit owns the HTTP call).
 */
export function planAgnesRegularFallback(
  outcome: FlashAttemptOutcome,
): AgnesRegularFallbackDecision {
  const trigger = evaluateFallbackTrigger(outcome);
  if (trigger !== "flash-failed-after-retry") {
    return { action: "no-escalation", reason: trigger };
  }

  const modeSelection = selectEscalationMode(outcome);
  if ("decline" in modeSelection) {
    return { action: "no-escalation", reason: modeSelection.decline };
  }

  const request = buildEscalationRequest(outcome, modeSelection.mode);
  return {
    action: "escalate-to-agnes-regular",
    reason: "flash-failed-after-retry",
    request,
  };
}

/** Build the validated Agnes Video 2.5 regular request plan. */
export function buildEscalationRequest(
  outcome: FlashAttemptOutcome,
  mode: AgnesRegularMode,
): AgnesRegularEscalationRequest {
  const refs = outcome.shot.referenceAssets ?? {};
  const attemptNumber = (outcome.priorModelIds?.length ?? 0) + 1;

  const request: AgnesRegularEscalationRequest = {
    provider: "agnes",
    modelId: AGNES_REGULAR_MODEL_ID,
    mode,
    size: DEFAULT_REGULAR_SIZE,
    seconds: regularSecondsString(outcome.shot.targetDurationSeconds),
    attemptNumber,
  };

  if (mode === "keyframe") {
    request.keyframes = {
      firstFrameUrl: refs.images?.[0],
      lastFrameUrl:
        outcome.shot.keyframeStrategy === "first-last-frame"
          ? refs.images?.[1]
          : undefined,
    };
  } else if (mode === "reference") {
    request.references = {
      images: refs.images ? [...refs.images] : undefined,
      videos: refs.videos ? [...refs.videos] : undefined,
      audios: refs.audios ? [...refs.audios] : undefined,
    };
  }
  return request;
}

/** True when `size` is a documented Agnes Video 2.5 regular tier. */
export function isRegularSizeTier(size: string): size is AgnesRegularSize {
  return (AGNES_REGULAR_SIZE_TIERS as readonly string[]).includes(size);
}