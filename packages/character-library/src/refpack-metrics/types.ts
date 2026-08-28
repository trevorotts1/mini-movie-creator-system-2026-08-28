/**
 * Reference-pack metrics types — spec §8: "Persist which references produced
 * accepted vs rejected clips so the planner learns best reference packs for
 * recurring characters/models."
 *
 * One recorded outcome = one generated clip together with the exact reference
 * pack (the reference asset IDs used) and whether the clip was ultimately
 * ACCEPTED (passed QC / approval) or REJECTED. DIR-013 (ReferenceBudgetPlanner)
 * consumes the aggregated rates as the "model-specific historical success"
 * term of its reference scoring.
 */

/** Terminal outcome of a generated clip for metrics purposes (spec §20 QC). */
export const CLIP_OUTCOMES = ["ACCEPTED", "REJECTED"] as const;

export type ClipOutcome = (typeof CLIP_OUTCOMES)[number];

/** True when `value` is a valid {@link ClipOutcome}. */
export function isClipOutcome(value: unknown): value is ClipOutcome {
  return (
    typeof value === "string" &&
    (CLIP_OUTCOMES as readonly string[]).includes(value)
  );
}

/** One persisted clip outcome with the reference pack that produced it. */
export interface RecordedOutcome {
  /** Store-assigned monotonic sequence (1-based, insertion order). */
  id: number;
  /** Stable character business ID (spec §9, e.g. CHAR_MONICA_BENNETT_001). */
  characterId: string;
  /** Provider model the clip was generated with (e.g. "agnes-flash-25"). */
  model: string;
  /** The reference asset IDs used, in the order they were passed to the
   * provider. A clip's pack is this full list — pack identity is order-sensitive
   * for pack queries but reference-rate queries ignore order. */
  referenceIds: string[];
  /** Whether the clip was accepted or rejected. */
  outcome: ClipOutcome;
  /** Shot the clip was generated for (spec §12 shot_id), when known. */
  shotId: string | null;
  /** Provider job / asset linkage (spec §18/§19), when known. */
  jobId: string | null;
  /** Why the clip was rejected (or a note on acceptance), when known. */
  reason: string | null;
  /** ISO 8601 instant the outcome was recorded. */
  occurredAt: string;
}

/** Input for recording one outcome; unknown optional fields become null. */
export interface RecordedOutcomeInput {
  characterId: string;
  model: string;
  referenceIds: readonly string[];
  outcome: ClipOutcome;
  shotId?: string | null;
  jobId?: string | null;
  reason?: string | null;
  /** Caller-supplied timestamp (tests / backfill); defaults to store clock. */
  occurredAt?: string;
  /** Idempotency key (e.g. provider job ID): recording the same key again
   * returns the existing outcome instead of duplicating it. */
  dedupeKey?: string;
}