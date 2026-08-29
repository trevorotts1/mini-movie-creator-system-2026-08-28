/** Barrel for the gate-6 canon-approval module (CHAR-013, spec §3 gate 6 / §10). */

export {
  approveAllProposedChanges,
  approveProposedCanonChange,
  canonForNextEpisode,
  describeCanonChange,
  generateCanonChangeId,
  listProposedCanonChanges,
  proposeEndOfEpisodeChanges,
  rejectProposedCanonChange,
  requireCanonGateApproved,
} from "./canon-approval.js";
export {
  CanonApprovalError,
  CanonGateNotApprovedError,
  CanonProposalInvalidError,
  DuplicateCanonChangeError,
} from "./errors.js";
export type {
  CanonGateSnapshot,
  CanonProposalDraft,
  CanonProposalOrigin,
  CanonProposalSource,
  EndOfEpisodeProposalInput,
  ProposedCanonChangesList,
  ProposedCanonChangeEntry,
} from "./types.js";
