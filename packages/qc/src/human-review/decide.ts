/**
 * Entry decision for the human REVIEW state (spec §20, task QC-011).
 *
 * Pure function over the merged outcomes of the automated pipeline. Entering
 * review REQUIRES an exhaustion signal — a shot the automated routes can
 * still legitimately retry must never land here, and a shot that passed must
 * never be held hostage for review. There is no "approve" outcome: approval
 * happens only through the human store, never by absence of a trigger.
 */

import type {
  HumanReviewEntryDecision,
  HumanReviewEntryInput,
  HumanReviewTrigger,
} from "./types.js";
import { HUMAN_REVIEW_TRIGGERS } from "./types.js";

/** Human-readable label per trigger, surfaced on records and `mmcs qc`. */
export const HUMAN_REVIEW_TRIGGER_LABELS: Readonly<
  Record<HumanReviewTrigger, string>
> = {
  "routes-exhausted":
    "automated retry routes exhausted (retry ladder terminal action)",
  "qc-verdict-review":
    "automated QC verdict REVIEW — reviewer flagged a check for human judgment",
  "review-unavailable":
    "no automated review route available (vision profile cannot review media)",
};

/**
 * Evaluate whether a shot must enter the persisted human REVIEW state.
 *
 * Priority when several signals coexist (first match wins):
 *  1. QC verdict REVIEW — a reviewer explicitly flagged human judgment;
 *  2. review route `unavailable` — no automated review ran at all;
 *  3. a concrete PASS verdict — the shot passed; it never waits on a human;
 *  4. repair action `review` — the retry ladder exhausted every route.
 *
 * A PASS verdict outranks the ladder's stale terminal `review` action: the
 * concrete verdict of a completed automated review wins. FAIL keeps the
 * automated repair loop alive (QC-006 owns regenerate/awaiting-approval);
 * only its terminal `review` action escalates.
 */
export function decideHumanReview(
  input: HumanReviewEntryInput,
): HumanReviewEntryDecision {
  if (input.shotId.trim() === "") {
    throw new Error("decideHumanReview: shotId is required");
  }
  if (input.episodeId.trim() === "") {
    throw new Error("decideHumanReview: episodeId is required");
  }

  if (input.qcVerdict === "REVIEW") {
    return {
      enter: true,
      trigger: "qc-verdict-review",
      reason:
        "automated QC returned verdict REVIEW — human judgment required before the shot may be used",
    };
  }

  if (input.reviewRoute === "unavailable") {
    return {
      enter: true,
      trigger: "review-unavailable",
      reason:
        "capability profile declares no vision — automated review impossible; shot parked for human review instead of silently passing",
    };
  }

  if (input.qcVerdict === "PASS") {
    return {
      enter: false,
      trigger: null,
      reason: "automated QC verdict PASS — no human review required",
    };
  }

  if (input.repairAction === "review") {
    const tried = input.routesTried ?? [];
    return {
      enter: true,
      trigger: "routes-exhausted",
      reason:
        tried.length > 0
          ? `automated routes exhausted after ${tried.join(" → ")} — human review`
          : "automated retry routes exhausted — human review",
    };
  }

  return {
    enter: false,
    trigger: null,
    reason:
      input.repairAction === "regenerate"
        ? "automated repair loop still has routes left — stays with QC-006 retry policy"
        : input.repairAction === "awaiting-approval"
          ? "regeneration blocked by spend policy — awaiting budget approval, not a review item"
          : "no exhaustion signal — automated pipeline remains responsible",
  };
}

/**
 * True when the evaluation carries a concrete exhaustion trigger. Convenience
 * guard for callers that already hold a decision.
 */
export function isReviewTrigger(value: unknown): value is HumanReviewTrigger {
  return (
    typeof value === "string" &&
    (HUMAN_REVIEW_TRIGGERS as readonly string[]).includes(value)
  );
}
