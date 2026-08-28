/**
 * Provider-job lifecycle (spec §18 "ASYNC PROVIDER JOB SAFETY").
 *
 * State machine:
 * `PLANNED → BUDGET_RESERVED → SUBMITTING → SUBMITTED → GENERATING →
 * GENERATED_TEMPORARY → ARCHIVING → ARCHIVED → QC_PENDING → (QC_FIXING →)
 * APPROVED | REJECTED`.
 *
 * Kept in the jobs repository module so the schema and the transitions it
 * guards stay together. QC_FIXING loops back to QC_PENDING; APPROVED and
 * REJECTED are terminal; everything else moves forward only.
 */

export const JOB_STATES = [
  "PLANNED",
  "BUDGET_RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "GENERATING",
  "GENERATED_TEMPORARY",
  "ARCHIVING",
  "ARCHIVED",
  "QC_PENDING",
  "QC_FIXING",
  "APPROVED",
  "REJECTED",
] as const;

export type ProviderJobState = (typeof JOB_STATES)[number];

/** Ordered forward path from PLANNED to QC_PENDING (the pre-approval ladder). */
const FORWARD_LADDER: readonly ProviderJobState[] = [
  "PLANNED",
  "BUDGET_RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "GENERATING",
  "GENERATED_TEMPORARY",
  "ARCHIVING",
  "ARCHIVED",
  "QC_PENDING",
];

/** True when `from` may legally transition to `to` under spec §18. */
export function isLegalJobTransition(from: ProviderJobState, to: ProviderJobState): boolean {
  if (from === "QC_FIXING") {
    // The repair loop returns to QC_PENDING for re-judgement.
    return to === "QC_PENDING";
  }
  const fromIndex = FORWARD_LADDER.indexOf(from);
  if (fromIndex === -1) {
    // Terminal states (APPROVED/REJECTED) have no onward transitions.
    return false;
  }
  if (to === "QC_FIXING" || to === "APPROVED") {
    return from === "QC_PENDING";
  }
  if (to === "REJECTED") {
    // Rejection is legal from any post-submission, pre-approval state:
    // a provider failure or QC failure rejects the job, budget releases.
    return fromIndex >= FORWARD_LADDER.indexOf("SUBMITTED");
  }
  const toIndex = FORWARD_LADDER.indexOf(to);
  return toIndex !== -1 && toIndex === fromIndex + 1;
}

/** Ordered states for introspection and UI progress rendering. */
export const JOB_STATE_ORDER: readonly ProviderJobState[] = FORWARD_LADDER;

/** Archival status of a job's generated output (spec §18 "archival status"). */
export const ARCHIVAL_STATUSES = ["PENDING", "IN_PROGRESS", "ARCHIVED", "FAILED", "SKIPPED"] as const;

export type ArchivalStatus = (typeof ARCHIVAL_STATUSES)[number];