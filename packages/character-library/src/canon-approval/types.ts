/**
 * Gate 6 canon-approval data shapes (spec §3 gate 6 "Canon/Series Bible
 * update", §10 "Proposed Canon Changes" review).
 *
 * The proposal layer (this module) sits on top of the series-bible canon
 * ledger (CHAR-012): drafts are derived from end-of-episode facts, batch
 * validated against every canon read they could ever join, staged as
 * PROPOSED CanonChanges, and only reach canon after the operator approves
 * them behind the persisted `canon` gate (CORE-008 approvals, read-only).
 */

import type {
  CanonChange,
  CanonMutation,
  EpisodeCode,
} from "../series-bible/types.js";

/**
 * The persisted gate snapshot this module reads, declared structurally (the
 * repo convention — VID-014's `ApprovalGatePort` does the same): CORE-008's
 * `GateSnapshot` for the `canon` gate satisfies it without a package
 * dependency. Read-only per ownership — this layer never writes the gate.
 */
export interface CanonGateSnapshot {
  /** Must be the `canon` gate (CORE-008 GATE_IDS). */
  gate: string;
  /** Persisted approval state (CORE-008 GATE_STATES). */
  state: "PENDING" | "APPROVED" | "REJECTED";
  /** ISO-8601 instant of the operator sign-off, when APPROVED. */
  approvedAt: string | null;
  /** ISO-8601 instant of a rejection, when REJECTED. */
  rejectedAt: string | null;
  /** Operator identity recorded with the decision, when given. */
  decidedBy: string | null;
  /** Operator note recorded with the decision, when given. */
  note: string | null;
}

/** Where an end-of-episode canon fact was observed. Story/text data is
 * untrusted input: it is validated and stored, never executed. */
export type CanonProposalOrigin =
  | "episode-summary"
  | "continuity-diff"
  | "plot-thread-tracker"
  | "manual";

/** Provenance for one proposed change (review-surface metadata only; the
 * bible's CanonChange ledger stays CHAR-012's shape). */
export interface CanonProposalSource {
  /** Pipeline stage the fact came from. */
  observedFrom: CanonProposalOrigin;
  /** Free-text evidence, e.g. the episode-summary sentence. Never executed. */
  evidence?: string;
}

/** One end-of-episode canon proposal before staging. */
export interface CanonProposalDraft {
  /** Explicit change ID; omitted → generated as `CC_<episode>_<seq>`. */
  changeId?: string;
  /** What the change proposes; omitted → derived from the mutations. */
  description?: string;
  /** Episode the change becomes canon from; omitted → the ended episode. */
  effectiveEpisode?: EpisodeCode;
  /** The concrete canon mutations, applied in order on approval. */
  mutations: CanonMutation[];
  /** Where the proposal came from, when known. */
  source?: CanonProposalSource;
}

/** Input to {@link proposeEndOfEpisodeChanges}. */
export interface EndOfEpisodeProposalInput {
  /** The episode that just ended, e.g. "S01E09". */
  episode: EpisodeCode;
  /** ISO-8601 instant the proposals were raised. */
  proposedAt: string;
  /** Observed end-of-episode facts mapped to canon mutations. */
  drafts: CanonProposalDraft[];
}

/** A staged proposal plus its review provenance. */
export interface ProposedCanonChangeEntry {
  /** The staged PROPOSED change in the bible's ledger. */
  change: CanonChange;
  /** Where the proposal came from, when known. */
  source?: CanonProposalSource;
}

/** The end-of-episode "Proposed Canon Changes" review surface (spec §10).
 * Nothing here has touched canon: every entry is PROPOSED until the
 * operator approves it behind the `canon` gate. */
export interface ProposedCanonChangesList {
  /** Series the proposals belong to. */
  seriesId: string;
  /** The episode that ended and produced the list. */
  episode: EpisodeCode;
  /** ISO-8601 instant the list was raised. */
  proposedAt: string;
  /** The staged proposals, in draft order. */
  entries: ProposedCanonChangeEntry[];
}

