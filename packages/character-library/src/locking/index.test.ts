import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  ASSET_STATES,
  CandidateStateError,
  CHARACTER_GATE_ID,
  CharacterAlreadyLockedError,
  CharacterLockService,
  LockNotApprovedError,
  UnknownLockCharacterError,
  assertCanonicalizable,
  canBecomeCanonical,
  isLockApproved,
  type AssetRecordStore,
  type CharacterGateReader,
  type CharacterRecordStore,
  type GateSnapshot,
  type LockableAsset as LockableAssetShape,
  type LockableCharacter as LockableCharacterShape,
} from "./index.js";

const NOW = "2026-08-28T12:00:00.000Z";

function gateSnapshot(
  state: GateSnapshot["state"],
  overrides: Partial<GateSnapshot> = {},
): GateSnapshot {
  return {
    gate: CHARACTER_GATE_ID,
    state,
    approvedAt: state === "APPROVED" ? NOW : null,
    rejectedAt: state === "REJECTED" ? NOW : null,
    decidedBy: state === "PENDING" ? null : "trevor",
    note: null,
    ...overrides,
  };
}

function gateReader(
  snapshot: GateSnapshot | null,
): CharacterGateReader {
  return { characterGate: () => snapshot };
}

/** In-memory character + asset stores with write-capture for assertions. */
function makeStores(
  character: LockableCharacterShape,
  assets: LockableAssetShape[],
): {
  characters: CharacterRecordStore;
  assets: AssetRecordStore;
  characterWrites: { characterId: string; state: LockableCharacterShape["state"] }[];
  assetWrites: { assetId: string; state: LockableAssetShape["state"] }[];
} {
  const characterWrites: {
    characterId: string;
    state: LockableCharacterShape["state"];
  }[] = [];
  const assetWrites: { assetId: string; state: LockableAssetShape["state"] }[] = [];
  const characterState = { ...character };
  const assetStates = new Map(assets.map((a) => [a.assetId, { ...a }]));
  return {
    characterWrites,
    assetWrites,
    characters: {
      get: (id) => (id === characterState.characterId ? { ...characterState } : null),
      setState: (id, state) => {
        characterState.state = state;
        characterWrites.push({ characterId: id, state });
      },
    },
    assets: {
      listByCharacter: (id) =>
        [...assetStates.values()]
          .filter((a) => a.characterId === id)
          .map((a) => ({ ...a })),
      setState: (assetId, state) => {
        const asset = assetStates.get(assetId);
        if (asset) {
          asset.state = state;
        }
        assetWrites.push({ assetId, state });
      },
    },
  };
}

const CHARACTER: LockableCharacterShape = {
  characterId: "CHAR_MONICA_BENNETT_001",
  state: "APPROVED",
};

function approvedAssets(): LockableAssetShape[] {
  return [
    { assetId: "IDENT_ASSET_001", characterId: CHARACTER.characterId, state: "APPROVED" },
    { assetId: "REF_PACK_002", characterId: CHARACTER.characterId, state: "APPROVED" },
  ];
}

function lockedService() {
  const stores = makeStores(CHARACTER, approvedAssets());
  const service = new CharacterLockService({
    gateReader: gateReader(gateSnapshot("APPROVED")),
    characters: stores.characters,
    assets: stores.assets,
  });
  return { service, ...stores };
}

describe("lock approval gate (spec §3 gate 3, §9)", () => {
  it("isLockApproved is true only for APPROVED gate snapshots", () => {
    expect(isLockApproved(gateSnapshot("APPROVED"))).toBe(true);
    expect(isLockApproved(gateSnapshot("PENDING"))).toBe(false);
    expect(isLockApproved(gateSnapshot("REJECTED"))).toBe(false);
    expect(isLockApproved(null)).toBe(false);
  });

  it("locking without approval throws LockNotApprovedError and mutates nothing", () => {
    for (const state of ["PENDING", "REJECTED"] as const) {
      const { service, characterWrites, assetWrites } = lockedServiceWithGate(state);
      expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
        LockNotApprovedError,
      );
      // Nothing was mutated — the throw happens before any state write.
      expect(characterWrites).toHaveLength(0);
      expect(assetWrites).toHaveLength(0);
    }
  });

  it("a missing gate snapshot (no store wired) throws and mutates nothing", () => {
    const stores = makeStores(CHARACTER, approvedAssets());
    const service = new CharacterLockService({
      gateReader: gateReader(null),
      characters: stores.characters,
      assets: stores.assets,
    });
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      LockNotApprovedError,
    );
    expect(stores.characterWrites).toHaveLength(0);
    expect(stores.assetWrites).toHaveLength(0);
  });

  it("a snapshot from a different gate does not count as lock approval", () => {
    const stores = makeStores(CHARACTER, approvedAssets());
    const service = new CharacterLockService({
      gateReader: gateReader(gateSnapshot("APPROVED", { gate: "script" })),
      characters: stores.characters,
      assets: stores.assets,
    });
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      /expected "character"/,
    );
    expect(stores.characterWrites).toHaveLength(0);
  });
});

function lockedServiceWithGate(state: GateSnapshot["state"]) {
  const stores = makeStores(CHARACTER, approvedAssets());
  const service = new CharacterLockService({
    gateReader: gateReader(gateSnapshot(state)),
    characters: stores.characters,
    assets: stores.assets,
  });
  return { service, ...stores };
}

describe("canonical transition (spec §9 DRAFT → APPROVED → CANONICAL)", () => {
  it("lock flips every asset through APPROVED to CANONICAL in spec order", () => {
    const draftAssets: LockableAssetShape[] = [
      { assetId: "A1", characterId: CHARACTER.characterId, state: "DRAFT" },
      { assetId: "A2", characterId: CHARACTER.characterId, state: "DRAFT" },
    ];
    const stores = makeStores(CHARACTER, draftAssets);
    const service = new CharacterLockService({
      gateReader: gateReader(gateSnapshot("APPROVED")),
      characters: stores.characters,
      assets: stores.assets,
    });

    const result = service.lock(CHARACTER.characterId, NOW);

    expect(result.characterState).toBe("CANONICAL");
    expect(result.lockedAssetIds).toEqual(["A1", "A2"]);
    // DRAFT -> REVIEW -> APPROVED -> CANONICAL, per asset, in order (shared
    // table path; APPROVED is the mandatory pre-canonical state).
    expect(stores.assetWrites.map((w) => `${w.assetId}:${w.state}`)).toEqual([
      "A1:REVIEW",
      "A1:APPROVED",
      "A1:CANONICAL",
      "A2:REVIEW",
      "A2:APPROVED",
      "A2:CANONICAL",
    ]);
    expect(stores.characterWrites).toEqual([
      { characterId: CHARACTER.characterId, state: "CANONICAL" },
    ]);
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "ASSET_TO_CANONICAL",
      "ASSET_TO_APPROVED",
      "ASSET_TO_CANONICAL",
      "ASSET_TO_CANONICAL",
      "ASSET_TO_APPROVED",
      "ASSET_TO_CANONICAL",
      "CHARACTER_TO_CANONICAL",
    ]);
  });

  it("already-APPROVED assets go straight APPROVED -> CANONICAL", () => {
    const { service, assetWrites } = lockedService();
    const result = service.lock(CHARACTER.characterId, NOW);
    expect(result.characterState).toBe("CANONICAL");
    expect(assetWrites.map((w) => `${w.assetId}:${w.state}`)).toEqual([
      "IDENT_ASSET_001:CANONICAL",
      "REF_PACK_002:CANONICAL",
    ]);
  });

  it("locking the same character twice throws CharacterAlreadyLockedError", () => {
    const { service } = lockedService();
    service.lock(CHARACTER.characterId, NOW);
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      CharacterAlreadyLockedError,
    );
  });

  it("an unknown character throws UnknownLockCharacterError", () => {
    const { service } = lockedService();
    expect(() => service.lock("CHAR_NOBODY_001", NOW)).toThrow(
      UnknownLockCharacterError,
    );
  });

  it("a non-ISO now throws before any mutation", () => {
    const { service, characterWrites, assetWrites } = lockedService();
    expect(() => service.lock(CHARACTER.characterId, "not-a-date")).toThrow(
      /ISO timestamp/,
    );
    expect(characterWrites).toHaveLength(0);
    expect(assetWrites).toHaveLength(0);
  });
});

describe("REJECTED never becomes CANONICAL (spec §9)", () => {
  it("assertCanonicalizable throws on every REJECTED asset", () => {
    expect(() => assertCanonicalizable("REJECTED")).toThrow(CandidateStateError);
    expect(() => assertCanonicalizable("REJECTED")).toThrow(
      /REJECTED candidates are terminal/,
    );
  });

  it("a rejected asset in the lock batch aborts the whole lock with zero writes", () => {
    const mixedAssets: LockableAssetShape[] = [
      { assetId: "GOOD", characterId: CHARACTER.characterId, state: "APPROVED" },
      { assetId: "BAD", characterId: CHARACTER.characterId, state: "REJECTED" },
    ];
    const stores = makeStores(CHARACTER, mixedAssets);
    const service = new CharacterLockService({
      gateReader: gateReader(gateSnapshot("APPROVED")),
      characters: stores.characters,
      assets: stores.assets,
    });
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      CandidateStateError,
    );
    expect(stores.characterWrites).toHaveLength(0);
    expect(stores.assetWrites).toHaveLength(0);
  });

  it("a rejected character record can never be locked", () => {
    const stores = makeStores(
      { characterId: CHARACTER.characterId, state: "REJECTED" },
      approvedAssets(),
    );
    const service = new CharacterLockService({
      gateReader: gateReader(gateSnapshot("APPROVED")),
      characters: stores.characters,
      assets: stores.assets,
    });
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      CandidateStateError,
    );
    expect(stores.characterWrites).toHaveLength(0);
    expect(stores.assetWrites).toHaveLength(0);
  });

  it("canBecomeCanonical: REJECTED/RETIRED false, live states true", () => {
    expect(canBecomeCanonical("REJECTED")).toBe(false);
    expect(canBecomeCanonical("RETIRED")).toBe(false);
    expect(canBecomeCanonical("CANONICAL")).toBe(true);
    expect(canBecomeCanonical("APPROVED")).toBe(true);
    expect(canBecomeCanonical("DRAFT")).toBe(true);
    expect(canBecomeCanonical("REVIEW")).toBe(true);
  });
});

describe("invariants and vocabulary", () => {
  it("the shared transition table has no REJECTED -> CANONICAL edge", () => {
    expect(ALLOWED_TRANSITIONS.REJECTED).toEqual([]);
    expect(ALLOWED_TRANSITIONS.APPROVED).toContain("CANONICAL");
  });

  it("the vocabulary covers exactly the six spec §9 asset states", () => {
    expect([...ASSET_STATES].sort()).toEqual(
      ["APPROVED", "CANONICAL", "DRAFT", "REJECTED", "RETIRED", "REVIEW"].sort(),
    );
  });

  it("an asset from a foreign character aborts the lock with zero writes", () => {
    const foreignAssets: LockableAssetShape[] = [
      { assetId: "MINE", characterId: CHARACTER.characterId, state: "APPROVED" },
      { assetId: "FOREIGN", characterId: "CHAR_OTHER_001", state: "APPROVED" },
    ];
    const stores = makeStores(CHARACTER, foreignAssets);
    // Defensive-store variant: listByCharacter returns everything it holds
    // (a corrupt/misbehaving store) — the service must catch the foreign row.
    const service = new CharacterLockService({
      gateReader: gateReader(gateSnapshot("APPROVED")),
      characters: stores.characters,
      assets: {
        listByCharacter: () => foreignAssets,
        setState: stores.assets.setState,
      },
    });
    expect(() => service.lock(CHARACTER.characterId, NOW)).toThrow(
      /does not belong to character/,
    );
    expect(stores.characterWrites).toHaveLength(0);
    expect(stores.assetWrites).toHaveLength(0);
  });
});
