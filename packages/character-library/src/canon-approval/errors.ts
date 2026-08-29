/** Error thrown on invalid canon-approval operations (gate 6, spec §10). */
export class CanonApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonApprovalError";
  }
}

/** Thrown when gate 6 has not been APPROVED but an approval was attempted:
 * "No permanent canon update without user approval (Gate 6)". */
export class CanonGateNotApprovedError extends CanonApprovalError {
  constructor(gateState: string) {
    super(
      `canon gate is ${gateState}, not APPROVED — no permanent canon update without Gate 6 user approval`,
    );
    this.name = "CanonGateNotApprovedError";
  }
}

/** Thrown when an end-of-episode proposal batch would stage a change ID
 * that already exists in the bible's ledger. */
export class DuplicateCanonChangeError extends CanonApprovalError {
  constructor(changeId: string) {
    super(`canon change ID already used: ${changeId}`);
    this.name = "DuplicateCanonChangeError";
  }
}

/** Thrown when a proposal's mutations fail validation against a canon
 * read it could ever join (see validateProposalsAgainstCanon). */
export class CanonProposalInvalidError extends CanonApprovalError {
  constructor(changeId: string, reason: string) {
    super(`canon proposal ${changeId} is invalid: ${reason}`);
    this.name = "CanonProposalInvalidError";
  }
}
