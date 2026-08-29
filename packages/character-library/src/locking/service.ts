/**
 * The LOCK CHARACTER service (spec §3 gate 3, §9).
 *
 * Owns the approval-gated transition of a selected candidate's assets to
 * CANONICAL, in the spec §9 order: every candidate asset moves
 * DRAFT → APPROVED → CANONICAL (the intermediate APPROVED hop is explicit so
 * the audit log shows the full spec path), and the character record itself
 * moves APPROVED → CANONICAL.
 *
 * Rules (spec §9 verbatim where quoted):
 * - "LOCK CHARACTER approval → only then CANONICAL": every mutating method
 *   validates the gate-3 approval BEFORE touching any state; a missing
 *   approval throws {@link LockNotApprovedError} and nothing is mutated.
 * - "Rejected candidates are never used later": a REJECTED asset or
 *   character can never be part of a lock; {@link assertCanonicalizable}
 *   throws before any state changes.
 * - A lock is single-shot: locking an already-canonical character throws
 *   {@link CharacterAlreadyLockedError}.
 * - The event log records every applied transition for audit/debuggability
 *   (pure data — durable persistence of these events is the caller's
 *   concern, e.g. the database repositories).
 *
 * Pure domain logic: no DB, no provider calls, no clock. Callers pass `now`
 * and supply the gate reader + record stores as injected ports.
 */

import { assertTransition, type AssetState } from "../candidates/candidate-state.js";
import {
  CHARACTER_GATE_ID,
  CharacterAlreadyLockedError,
  LockNotApprovedError,
  UnknownLockCharacterError,
  assertCanonicalizable,
  canBecomeCanonical,
  isLockApproved,
  type CharacterGateReader,
  type LockableAsset,
  type LockableCharacter,
} from "./index.js";
import {
  CharacterAlreadyLockedError as AlreadyLockedError,
  ForeignAssetError,
  LockNotApprovedError as NotApprovedError,
  UnknownLockCharacterError as UnknownCharacterError,
} from "./errors.js";

/** Read-write view over one character record (durable store is a port). */
export interface CharacterRecordStore {
  /** Returns the current record or null when the ID is unknown. */
  get(characterId: string): LockableCharacter | null;
  /** Persist the (already validated) next state. */
  setState(characterId: string, state: AssetState, at: string): void;
}

/** Read-write view over the character's reference-pack assets. */
export interface AssetRecordStore {
  /** All assets owned by the character (any state, oldest first). */
  listByCharacter(characterId: string): LockableAsset[];
  /** Persist the (already validated) next state. */
  setState(assetId: string, state: AssetState, at: string): void;
}

/** One applied state transition, for the audit log. */
export interface LockEvent {
  readonly at: string;
  readonly kind:
    | "ASSET_TO_APPROVED"
    | "ASSET_TO_CANONICAL"
    | "CHARACTER_TO_CANONICAL";
  readonly characterId: string;
  readonly assetId: string | null;
  readonly from: AssetState;
  readonly to: AssetState;
}

/** The result of a successful lock. */
export interface LockResult {
  readonly characterId: string;
  /** The character's state after the lock (always CANONICAL). */
  readonly characterState: AssetState;
  /** Asset IDs flipped by this lock, in the order they were processed. */
  readonly lockedAssetIds: readonly string[];
  readonly events: readonly LockEvent[];
}

export interface CharacterLockServiceDeps {
  gateReader: CharacterGateReader;
  characters: CharacterRecordStore;
  assets: AssetRecordStore;
}

export class CharacterLockService {
  private readonly gateReader: CharacterGateReader;
  private readonly characters: CharacterRecordStore;
  private readonly assets: AssetRecordStore;

  constructor(deps: CharacterLockServiceDeps) {
    this.gateReader = deps.gateReader;
    this.characters = deps.characters;
    this.assets = deps.assets;
  }

  /** The character gate snapshot (read-only projection). */
  characterGateSnapshot(): import("./gate-snapshot.js").GateSnapshot | null {
    return this.gateReader.characterGate();
  }

  /** True when the durable gate-3 record counts as LOCK CHARACTER approval. */
  isLockApproved(): boolean {
    return isLockApproved(this.gateReader.characterGate());
  }

  /**
   * Apply LOCK CHARACTER: approval check first, then DRAFT→APPROVED→CANONICAL
   * for every asset of the character, then APPROVED→CANONICAL for the
   * character record. Throws without mutating on any rule violation.
   */
  lock(characterId: string, now: string): LockResult {
    if (Number.isNaN(Date.parse(now))) {
      throw new Error(`now must be an ISO timestamp, got ${JSON.stringify(now)}`);
    }
    this.requireApproval();

    const character = this.characters.get(characterId);
    if (character === null) {
      throw new UnknownCharacterError(characterId);
    }
    if (character.state === "CANONICAL") {
      throw new AlreadyLockedError(characterId);
    }
    assertCanonicalizable(character.state);

    // Validate the whole batch BEFORE mutating anything: a single illegal
    // asset state aborts the lock with zero writes (all-or-nothing).
    const assets = this.assets.listByCharacter(characterId);
    for (const asset of assets) {
      if (asset.characterId !== characterId) {
        throw new ForeignAssetError(asset.assetId, characterId);
      }
      if (!canBecomeCanonical(asset.state)) {
        assertCanonicalizable(asset.state);
      }
    }

    const events: LockEvent[] = [];
    const lockedAssetIds: string[] = [];
    for (const asset of assets) {
      this.applyAssetTransition(asset, events, characterId, now);
      lockedAssetIds.push(asset.assetId);
    }

    assertTransition(character.state, "CANONICAL");
    this.characters.setState(characterId, "CANONICAL", now);
    events.push({
      at: now,
      kind: "CHARACTER_TO_CANONICAL",
      characterId,
      assetId: null,
      from: character.state,
      to: "CANONICAL",
    });

    return { characterId, characterState: "CANONICAL", lockedAssetIds, events };
  }

  /**
   * Walk one asset along the shared forward path to CANONICAL
   * (DRAFT → REVIEW → APPROVED → CANONICAL, per the shared transition
   * table; APPROVED is the mandatory pre-canonical state and is observable
   * in the audit log). Every hop is validated against the table.
   */
  private applyAssetTransition(
    asset: LockableAsset,
    events: LockEvent[],
    characterId: string,
    now: string,
  ): void {
    let from = asset.state;
    while (from !== "APPROVED") {
      const to: AssetState = from === "DRAFT" ? "REVIEW" : "APPROVED";
      assertTransition(from, to);
      this.assets.setState(asset.assetId, to, now);
      events.push({
        at: now,
        kind: to === "APPROVED" ? "ASSET_TO_APPROVED" : "ASSET_TO_CANONICAL",
        characterId,
        assetId: asset.assetId,
        from,
        to,
      });
      from = to;
    }
    assertTransition("APPROVED", "CANONICAL");
    this.assets.setState(asset.assetId, "CANONICAL", now);
    events.push({
      at: now,
      kind: "ASSET_TO_CANONICAL",
      characterId,
      assetId: asset.assetId,
      from: "APPROVED",
      to: "CANONICAL",
    });
  }

  /** Gate check shared by every mutating path — throws before any mutation. */
  private requireApproval(): void {
    const gate = this.gateReader.characterGate();
    if (!isLockApproved(gate)) {
      throw new NotApprovedError(gate === null ? null : gate.state);
    }
    // The snapshot must be the character gate, not some other gate's record.
    const snapshot = this.gateReader.characterGate();
    if (snapshot !== null && snapshot.gate !== CHARACTER_GATE_ID) {
      throw new NotApprovedError(
        snapshot.state,
        `gate snapshot is "${snapshot.gate}", expected "${CHARACTER_GATE_ID}"`,
      );
    }
  }
}
