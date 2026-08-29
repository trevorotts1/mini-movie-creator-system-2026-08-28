/**
 * Gate 6 canon-approval orchestration (spec §3 gate 6 "Canon/Series Bible
 * update", §10 "End of episode → Proposed Canon Changes review").
 *
 * Composition contract with the series-bible canon ledger (CHAR-012):
 * that ledger owns the CanonChange lifecycle (propose → approve/reject,
 * sequential canonVersion, canon-at-time replay). This module sits on top:
 *
 * - End of episode: observed facts are validated (a dry run on a cloned
 *   bible — a proposal that could break any canon-at-time replay never
 *   enters the ledger), staged as PROPOSED CanonChanges, and returned as
 *   the "Proposed Canon Changes" review list. Canon is untouched.
 * - Review: PROPOSED entries are listed for the operator; nothing applies
 *   without an explicit decision.
 * - Approval: no permanent canon update without Gate 6 — the caller passes
 *   the persisted `canon` gate snapshot (CORE-008 approvals, read-only
 *   here; the CLI/store layer owns writing the gate) and approval throws
 *   unless the gate is APPROVED. Approved proposals are stamped by the
 *   ledger with the next sequential canonVersion.
 * - Rejection: terminal, needs no gate — rejecting touches no canon.
 *
 * Story/text data in proposals and gate snapshots is untrusted input: it is
 * validated, stored, and echoed for review — never executed.
 */

import {
  approveCanonChange,
  currentCanon,
  episodeNumber,
  rejectCanonChange,
  SeriesBibleError,
} from "../series-bible/canon.js";
import { proposeCanonChange } from "../series-bible/bible.js";
import type {
  CanonChange,
  CanonMutation,
  EpisodeCode,
  SeriesBible,
} from "../series-bible/types.js";
import {
  CanonApprovalError,
  CanonGateNotApprovedError,
  CanonProposalInvalidError,
  DuplicateCanonChangeError,
} from "./errors.js";
import type {
  CanonGateSnapshot,
  CanonProposalDraft,
  ProposedCanonChangesList,
  ProposedCanonChangeEntry,
} from "./types.js";

/** The one gate id this module reads. */
const CANON_GATE_ID = "canon";

/** Assert `value` is an ISO-8601 instant. Untrusted input must surface. */
function assertIsoTimestamp(value: string, field: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CanonApprovalError(
      `canon-approval field "${field}" is not an ISO-8601 timestamp: ${JSON.stringify(value)}`,
    );
  }
}

/** Next sequential per-episode proposal number: highest used + 1 (1-based,
 * zero-padded to 3 like the spec's "CC_S01E09_001" example). */
function nextChangeSequence(bible: SeriesBible, episode: EpisodeCode): number {
  const prefix = `CC_${episode}_`;
  let max = 0;
  for (const change of bible.canonChanges) {
    if (change.changeId.startsWith(prefix)) {
      const tail = change.changeId.slice(prefix.length);
      const seq = Number.parseInt(tail, 10);
      if (Number.isInteger(seq) && seq > max) {
        max = seq;
      }
    }
  }
  return max + 1;
}

/**
 * Generated change ID for an episode's next proposal, e.g. "CC_S01E09_003".
 * `assignedIds` carries IDs already handed out in the current batch, so two
 * ID-less drafts in one proposal never collide on the same number.
 */
function computeGeneratedCanonChangeId(
  bible: SeriesBible,
  episode: EpisodeCode,
  assignedIds: ReadonlySet<string>,
): string {
  const prefix = `CC_${episode}_`;
  let max = nextChangeSequence(bible, episode) - 1;
  const scan = (id: string): void => {
    if (id.startsWith(prefix)) {
      const seq = Number.parseInt(id.slice(prefix.length), 10);
      if (Number.isInteger(seq) && seq > max) {
        max = seq;
      }
    }
  };
  for (const id of assignedIds) {
    scan(id);
  }
  return `CC_${episode}_${String(max + 1).padStart(3, "0")}`;
}

/** Generated change ID for an episode's next proposal, e.g. "CC_S01E09_003". */
export function generateCanonChangeId(
  bible: SeriesBible,
  episode: EpisodeCode,
): string {
  return computeGeneratedCanonChangeId(bible, episode, new Set());
}

/** Human-readable one-line summary of what a proposal mutates, derived from
 * the mutations themselves (the review surface when no description given). */
export function describeCanonChange(mutations: CanonMutation[]): string {
  const counts = new Map<string, number>();
  for (const mutation of mutations) {
    counts.set(mutation.op, (counts.get(mutation.op) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([op, count]) =>
    count === 1 ? op : `${op} ×${count}`,
  );
  return `${mutations.length} canon mutation${mutations.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/**
 * Dry-run a batch of staged changes: clone the bible, stage every draft,
 * then approve each in order on the clone. The ledger's own approval
 * validation replays every canon-at-time read the change could ever join
 * (its effective episode, every approved episode at or after it, live
 * canon) AND the changes before it in the batch — so intra-batch conflicts
 * (e.g. batch adds a character the next draft already requires present)
 * surface here instead of mid-approval on the real bible. Nothing on the
 * real bible is touched; the clone is discarded.
 */
function dryRunBatch(
  bible: SeriesBible,
  drafts: Array<{
    changeId: string;
    description: string;
    effectiveEpisode: EpisodeCode;
    mutations: CanonMutation[];
    proposedAt: string;
    decidedAt: string;
  }>,
): void {
  const clone = structuredClone(bible) as SeriesBible;
  for (const draft of drafts) {
    proposeCanOnChangeSafe(clone, draft);
  }
  for (const draft of drafts) {
    try {
      approveCanonChange(clone, draft.changeId, draft.decidedAt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CanonProposalInvalidError(draft.changeId, reason);
    }
  }
}

/** Stage one change on the working bible, translating ledger errors. */
function proposeCanOnChangeSafe(
  bible: SeriesBible,
  draft: {
    changeId: string;
    description: string;
    effectiveEpisode: EpisodeCode;
    mutations: CanonMutation[];
    proposedAt: string;
  },
): void {
  try {
    proposeCanonChange(bible, {
      changeId: draft.changeId,
      description: draft.description,
      effectiveEpisode: draft.effectiveEpisode,
      proposedAt: draft.proposedAt,
      mutations: draft.mutations,
    });
  } catch (error) {
    if (error instanceof SeriesBibleError) {
      if (error.message.includes("already used")) {
        throw new DuplicateCanonChangeError(draft.changeId);
      }
      throw new CanonProposalInvalidError(draft.changeId, error.message);
    }
    throw error;
  }
}

/**
 * End of episode (spec §10): validate observed facts, stage them as
 * PROPOSED CanonChanges, and return the "Proposed Canon Changes" review
 * list. No mutation touches canon — only a later Gate 6 approval does.
 *
 * Validation runs the whole batch through a cloned-bible dry run first, so
 * a draft that would break any canon-at-time replay (or conflict with its
 * batch neighbors) fails here with the offending changeId and nothing is
 * staged. Duplicate change IDs (caller-supplied) throw before staging.
 */
export function proposeEndOfEpisodeChanges(
  bible: SeriesBible,
  input: {
    /** The episode that just ended. */
    episode: EpisodeCode;
    /** ISO-8601 instant the proposals were raised. */
    proposedAt: string;
    /** Observed end-of-episode facts mapped to canon mutations. */
    drafts: CanonProposalDraft[];
    /** Approval instant to validate with during the dry run (defaults to
     * `proposedAt`; must be ISO-8601 either way). */
    decidedAt?: string;
  },
): ProposedCanonChangesList {
  assertIsoTimestamp(input.proposedAt, "proposedAt");
  if (input.drafts.length === 0) {
    throw new CanonApprovalError(
      `end-of-episode proposal for ${input.episode} has no drafts`,
    );
  }
  // Normalize + derive IDs/descriptions before validating anything. IDs are
  // assigned in draft order and tracked, so ID-less drafts increment.
  const assignedIds = new Set<string>();
  const normalized = input.drafts.map((draft) => {
    if (!Array.isArray(draft.mutations) || draft.mutations.length === 0) {
      throw new CanonApprovalError(
        `canon proposal draft proposes no mutations (episode ${input.episode})`,
      );
    }
    const effectiveEpisode = draft.effectiveEpisode ?? input.episode;
    const changeId =
      draft.changeId ??
      computeGeneratedCanonChangeId(bible, effectiveEpisode, assignedIds);
    assignedIds.add(changeId);
    return {
      source: draft.source,
      changeId,
      description: draft.description ?? describeCanonChange(draft.mutations),
      effectiveEpisode,
      mutations: draft.mutations,
      proposedAt: input.proposedAt,
      decidedAt: input.decidedAt ?? input.proposedAt,
    };
  });
  // Duplicate IDs within the batch surface before any staging.
  const seen = new Set<string>();
  for (const draft of normalized) {
    if (seen.has(draft.changeId)) {
      throw new DuplicateCanonChangeError(draft.changeId);
    }
    seen.add(draft.changeId);
  }
  dryRunBatch(bible, normalized);
  const entries: ProposedCanonChangeEntry[] = normalized.map((draft) => {
    proposeCanOnChangeSafe(bible, draft);
    const change = bible.canonChanges.find((c) => c.changeId === draft.changeId);
    if (!change) {
      throw new CanonApprovalError(
        `staged canon change ${draft.changeId} vanished from the ledger`,
      );
    }
    return { change, source: draft.source };
  });
  return {
    seriesId: bible.seriesId,
    episode: input.episode,
    proposedAt: input.proposedAt,
    entries,
  };
}

/**
 * The review surface: every PROPOSED change still awaiting a Gate 6
 * decision, optionally narrowed to one episode. Ordered by effective
 * episode, then proposal order — the operator reads oldest-first.
 */
export function listProposedCanonChanges(
  bible: SeriesBible,
  opts?: { episode?: EpisodeCode },
): ProposedCanonChangeEntry[] {
  const entries = bible.canonChanges
    .filter((c) => c.status === "PROPOSED")
    .filter((c) => opts?.episode === undefined || c.effectiveEpisode === opts.episode)
    .sort(
      (a, b) =>
        episodeNumber(a.effectiveEpisode) - episodeNumber(b.effectiveEpisode),
    )
    .map((change) => ({ change }));
  return entries;
}

/**
 * Gate 6 check: the persisted `canon` gate must be APPROVED before any
 * permanent canon update. Read-only — the caller passes the snapshot from
 * the approvals store (CORE-008); this layer never writes the gate.
 */
export function requireCanonGateApproved(
  gate: CanonGateSnapshot,
): CanonGateSnapshot {
  if (gate.gate !== CANON_GATE_ID) {
    throw new CanonApprovalError(
      `expected the "canon" gate snapshot, got ${JSON.stringify(gate.gate)}`,
    );
  }
  if (gate.state !== "APPROVED") {
    throw new CanonGateNotApprovedError(gate.state);
  }
  return gate;
}

/** Decision options shared by the gated approval paths. */
export interface ApproveProposedOptions {
  /** The persisted gate snapshot proving operator sign-off (must be the
   * `canon` gate in APPROVED state). */
  gate: CanonGateSnapshot;
  /** ISO-8601 instant the approval was decided. */
  decidedAt: string;
}

/**
 * Approve ONE proposed change behind Gate 6: throws unless the `canon`
 * gate snapshot is APPROVED ("No permanent canon update without user
 * approval"), then delegates to the ledger — which validates the change
 * against every canon read it could ever join and stamps the next
 * sequential canonVersion. A validation failure keeps the change PROPOSED.
 */
export function approveProposedCanonChange(
  bible: SeriesBible,
  changeId: string,
  options: ApproveProposedOptions,
): CanonChange {
  assertIsoTimestamp(options.decidedAt, "decidedAt");
  requireCanonGateApproved(options.gate);
  return approveCanonChange(bible, changeId, options.decidedAt);
}

/**
 * Approve every currently PROPOSED change (optionally only one episode's)
 * behind Gate 6, in proposal order, atomically: a dry run on a cloned
 * bible validates the whole batch first — if any change would fail, the
 * error names it and the real bible keeps every change PROPOSED. Each
 * approved change is stamped by the ledger with the next canonVersion.
 */
export function approveAllProposedChanges(
  bible: SeriesBible,
  options: ApproveProposedOptions & { episode?: EpisodeCode },
): CanonChange[] {
  assertIsoTimestamp(options.decidedAt, "decidedAt");
  requireCanonGateApproved(options.gate);
  const pending = bible.canonChanges.filter(
    (c) =>
      c.status === "PROPOSED" &&
      (options.episode === undefined || c.effectiveEpisode === options.episode),
  );
  if (pending.length === 0) {
    throw new CanonApprovalError(
      options.episode === undefined
        ? "no proposed canon changes to approve"
        : `no proposed canon changes for ${options.episode}`,
    );
  }
  // Dry run: a mid-batch failure must leave nothing half-approved.
  const clone = structuredClone(bible) as SeriesBible;
  for (const change of pending) {
    try {
      approveCanonChange(clone, change.changeId, options.decidedAt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CanonProposalInvalidError(change.changeId, reason);
    }
  }
  return pending.map((change) =>
    approveCanonChange(bible, change.changeId, options.decidedAt),
  );
}

/**
 * Reject ONE proposed change (operator sends the observation back — the
 * work is revised, not canonized). Terminal, and needs no gate: rejecting
 * never touches canon. The change stays in the ledger as REJECTED.
 */
export function rejectProposedCanonChange(
  bible: SeriesBible,
  changeId: string,
  decidedAt: string,
): CanonChange {
  assertIsoTimestamp(decidedAt, "decidedAt");
  return rejectCanonChange(bible, changeId, decidedAt);
}

/**
 * The canon state a NEW episode should produce against: the replay of
 * every approved change (the live canon), plus any world rules/threads the
 * operator still holds PROPOSED shown separately — producers must never
 * silently build on unapproved canon. Historical reads use the ledger's
 * {@link canonAtEpisode}.
 */
export function canonForNextEpisode(bible: SeriesBible): {
  approved: ReturnType<typeof currentCanon>;
  pending: ProposedCanonChangeEntry[];
} {
  return {
    approved: currentCanon(bible),
    pending: listProposedCanonChanges(bible),
  };
}
