/**
 * Lock/canonical transition error types (spec §3 gate 3, §9).
 *
 * Defined in their own module (hair/ pattern) so the barrel and the service
 * share one set of classes without circular imports.
 */

import { CHARACTER_GATE_ID, type GateState } from "./gate-snapshot.js";

/** Thrown when the LOCK CHARACTER approval is missing or not APPROVED. */
export class LockNotApprovedError extends Error {
  readonly gateState: GateState | null;

  constructor(gateState: GateState | null, detail?: string) {
    super(
      `LOCK CHARACTER requires gate "${CHARACTER_GATE_ID}" APPROVED ` +
        `(spec §3 gate 3, §9); gate state is ` +
        `${gateState === null ? "unreadable" : gateState}` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "LockNotApprovedError";
    this.gateState = gateState;
  }
}

/** Thrown when an already-canonical character is locked a second time. */
export class CharacterAlreadyLockedError extends Error {
  readonly characterId: string;

  constructor(characterId: string) {
    super(
      `character ${characterId} is already CANONICAL and cannot be locked again`,
    );
    this.name = "CharacterAlreadyLockedError";
    this.characterId = characterId;
  }
}

/** Thrown when the named character is not found in the supplied records. */
export class UnknownLockCharacterError extends Error {
  readonly characterId: string;

  constructor(characterId: string) {
    super(`unknown character for lock: ${characterId}`);
    this.name = "UnknownLockCharacterError";
    this.characterId = characterId;
  }
}

/** Thrown when an asset does not belong to the character being locked. */
export class ForeignAssetError extends Error {
  readonly assetId: string;
  readonly characterId: string;

  constructor(assetId: string, characterId: string) {
    super(`asset ${assetId} does not belong to character ${characterId}`);
    this.name = "ForeignAssetError";
    this.assetId = assetId;
    this.characterId = characterId;
  }
}
