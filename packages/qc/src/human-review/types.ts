/**
 * Human REVIEW state (spec §20, runbook §24 QC/routing, task QC-011).
 *
 * "Retry routing policy per shot class: Agnes Flash acceptance route → Agnes
 * regular fallback → Seedance fallback → Wan hero/complex fallback → human
 * REVIEW state when automated routes exhaust."
 *
 * The human REVIEW state is a PERSISTED DOMAIN STATE (spec §3 discipline:
 * approval gates are persisted domain states — the same rigor applies to the
 * shot-level REVIEW verdict). It is entered ONLY by an explicit trigger from
 * the automated pipeline and left ONLY by a recorded human decision:
 *
 *  - `routes-exhausted`     — the retry ladder (QC-006) returned its terminal
 *    `review` action: every automated route spent its attempt budget.
 *  - `qc-verdict-review`    — the automated QC rollup (QC-001) returned
 *    verdict REVIEW: the reviewer flagged a check for human judgment.
 *  - `review-unavailable`   — the route decision (QC-005) was `unavailable`:
 *    the configured vision profile cannot review media at all.
 *
 * NO silent auto-approval (the load-bearing invariant of this task):
 *  - the entry decision type has no "approve" outcome — evaluation can enter
 *    review or leave the shot with the automated pipeline, nothing else;
 *  - only `HumanReviewStore.resolve()` moves a record to APPROVED/REJECTED,
 *    and it REFUSES to run without a human identity (`decidedBy`);
 *  - an APPROVED/REJECTED record without `decidedBy`/`decidedAt` on disk is
 *    corrupt data and throws on load — external damage surfaces, never a
 *    fabricated approval.
 */

/** Persisted states of a human-review record. REVIEW = undecided. */
export const HUMAN_REVIEW_STATES = ["REVIEW", "APPROVED", "REJECTED"] as const;

export type HumanReviewState = (typeof HUMAN_REVIEW_STATES)[number];

/**
 * Why the shot entered human REVIEW. Every trigger is an EXHAUSTION signal
 * from the automated pipeline — never a bypass of it.
 */
export const HUMAN_REVIEW_TRIGGERS = [
  "routes-exhausted",
  "qc-verdict-review",
  "review-unavailable",
] as const;

export type HumanReviewTrigger = (typeof HUMAN_REVIEW_TRIGGERS)[number];

/**
 * Structural trigger inputs — each field is the merged output of the module
 * that owns it (QC-006 retry plan, QC-001 schema rollup, QC-005 route
 * decision). All optional: whichever subsystems ran contribute their outcome;
 * the evaluator never guesses a missing one.
 */
export interface HumanReviewEntryInput {
  shotId: string;
  episodeId: string;
  /** 0-based generation attempt this signal is about. Default 0. */
  attempt?: number;
  /** QC-006 repair-plan action for the failed shot. */
  repairAction?: "regenerate" | "keep" | "review" | "awaiting-approval";
  /** QC-005 route decision for the review pass. */
  reviewRoute?: "video-direct" | "extracted-frames" | "unavailable";
  /** QC-001 rolled-up shot verdict. */
  qcVerdict?: "PASS" | "FAIL" | "REVIEW";
  /** Automated routes already tried on this shot, in escalation order. */
  routesTried?: readonly string[];
}

/**
 * Entry decision. `enter: true` carries the concrete trigger; `enter: false`
 * carries the reason the automated pipeline is still responsible. There is
 * deliberately NO approved outcome — approval is a human act on the store.
 */
export type HumanReviewEntryDecision =
  | { enter: true; trigger: HumanReviewTrigger; reason: string }
  | { enter: false; trigger: null; reason: string };

/** Durable record of one shot's human review (one row per shot). */
export interface HumanReviewRecord {
  /** Primary key — the shots table PK (spec §20 shot spec `shot_id`). */
  shotId: string;
  episodeId: string;
  /** Owning scene, when known (provenance for the report). */
  sceneId: string | null;
  /** 0-based generation attempt the review signal is about. */
  attempt: number;
  /** Which exhaustion trigger entered this review. */
  trigger: HumanReviewTrigger;
  /** Human-readable why (surfaces verbatim on `mmcs qc`). */
  reason: string;
  /** Automated routes tried before review, in escalation order. */
  routesTried: string[];
  state: HumanReviewState;
  /** ISO-8601 instant the shot first entered REVIEW (stable across refresh). */
  enteredAt: string;
  /** ISO-8601 instant of the last state change of any kind. */
  updatedAt: string;
  /**
   * ISO-8601 instant of the APPROVED/REJECTED decision; null while REVIEW.
   * Cleared by reopen — a REVIEW record never carries a decision instant.
   */
  decidedAt: string | null;
  /**
   * Human identity of the decider (e.g. "trevor"). REQUIRED for
   * APPROVED/REJECTED — an approval without a recorded human is corrupt and
   * rejected on load. May survive on REVIEW as the reopen trail (who last
   * re-opened it); it never implies approval by itself.
   */
  decidedBy: string | null;
  /** Operator note carried with the decision (or the reopen). */
  note: string | null;
}

/** Decision applied by a human on a REVIEW record. */
export interface HumanReviewDecisionInput {
  /**
   * Who signed off. REQUIRED for approve/reject — an anonymous decision is
   * refused before it can reach disk. Optional for reopen (which records no
   * new decision and clears the prior one).
   */
  decidedBy?: string;
  /** Operator note/reason (optional but recommended). */
  note?: string;
  /** Injectable clock for tests; default `new Date().toISOString()`. */
  now?: string;
}

/** Input for re-entering review after a fix attempt (markReview). */
export interface MarkReviewInput {
  shotId: string;
  episodeId: string;
  sceneId?: string | null;
  attempt?: number;
  trigger: HumanReviewTrigger;
  reason: string;
  routesTried?: readonly string[];
  /** Injectable clock for tests; default `new Date().toISOString()`. */
  now?: string;
}

/** Read-filter for listing review records. */
export interface ListReviewsQuery {
  /** Restrict to one episode. */
  episodeId?: string;
  /** Include APPROVED/REJECTED records (default: REVIEW only). */
  includeResolved?: boolean;
}
