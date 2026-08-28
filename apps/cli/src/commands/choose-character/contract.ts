// Selection/retry UI-CLI contract for `mmcs choose-character` (spec §3 gate 3, §9).
//
// CHAR-004 owns this contract layer. The 3-candidate UX is exact (spec §9):
//   Character 1 / 2 / 3 → pick "1 / 2 / 3 / 4-Try Again"
//   4 = Try Again → three NEW candidates; previous rejected kept draft/rejected,
//   never reusable.
//
// This module is pure: parsing, validation, and the state transitions the CLI
// surface drives. Candidate persistence and generation live in CHAR-003's
// `packages/character-library/src/candidates/`; gate state lives in the durable
// approval store. Both arrive as injected ports so the CLI stays testable and
// never reaches into other packages' internals directly.

/**
 * Command-spec shape this task exports for the CORE-011 dispatcher
 * (`apps/cli/src/dispatch/registry.ts` — mergeSpecs). Declared here, not
 * imported, because CORE-011 merges at integration; the shape is identical to
 * its `CommandSpec`, so the merge is structural. Do not diverge.
 */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const USAGE_CHOOSE_CHARACTER = [
  "Usage: mmcs choose-character <1|2|3|4>",
  "",
  "  1|2|3  select Character 1, 2, or 3 from the current candidate set (gate 3)",
  "  4      Try Again — discard the current set as rejected and create 3 NEW candidates",
  "",
  "Candidates come from `mmcs cast`. Selection does NOT lock the character;",
  "locking requires `mmcs approve-character <id>` after selection (spec §9).",
].join("\n");

export const USAGE_APPROVE_CHARACTER = [
  "Usage: mmcs approve-character <id>",
  "",
  "Locks a character version after it has been selected at gate 3 (spec §9).",
  "Run `mmcs choose-character <1|2|3>` first; then approve with the character ID",
  "printed by the selection.",
].join("\n");

/** The exact candidate selection alphabet (spec §9): 1 / 2 / 3 / 4-Try Again. */
export const SELECTION_ALPHABET = ["1", "2", "3", "4"] as const;
export type CandidateSelection = (typeof SELECTION_ALPHABET)[number];

export const TRY_AGAIN_SELECTION: CandidateSelection = "4";

/** What the operator chose, normalized for the caller. */
export type SelectionOutcome =
  | { kind: "selected"; candidateIndex: 1 | 2 | 3 }
  | { kind: "try-again" };

/**
 * Parse a raw `<candidate>` argument into a selection.
 * Returns the invalid marker (undefined) when the input is not exactly
 * 1/2/3/4 — the caller then prints the usage text and exits nonzero.
 * Story/script text is untrusted: this never evaluates input, only compares
 * the whole string against the fixed alphabet (spec §29).
 */
export function parseSelection(raw: string | undefined): SelectionOutcome | undefined {
  const value = (raw ?? "").trim();
  if (value === TRY_AGAIN_SELECTION) return { kind: "try-again" };
  if (value === "1" || value === "2" || value === "3") {
    return { kind: "selected", candidateIndex: Number(value) as 1 | 2 | 3 };
  }
  return undefined;
}

/**
 * Minimal port over the durable approval-gate state (spec §3). The CLI reads
 * it to enforce stop conditions; a real store arrives with CORE-008/CORE-014.
 */
export interface GateStatePort {
  /** True only when the operator has approved the script (gate 2). */
  isScriptApproved(): boolean;
  /** True once a candidate has been selected for lock (gate 3, pre-approval). */
  hasSelectedCandidate(): boolean;
  /** The character ID awaiting LOCK CHARACTER approval, if any. */
  getSelectedCharacterId(): string | null;
}

/** Port over CHAR-003's candidate flow. */
export interface CandidateFlowPort {
  /** Reject the current set and create 3 NEW candidates (spec §9 Try Again). */
  regenerateCandidates(): { candidates: { index: 1 | 2 | 3; characterId: string }[] };
  /** Mark candidate `n` as the selection; returns the character to lock. */
  selectCandidate(index: 1 | 2 | 3): { characterId: string; displayName: string };
}

/**
 * Result of one `choose-character` invocation. `exitCode` is the CLI's
 * documented contract: 0 on success, 1 on any rejection.
 */
export type ChooseCharacterResult = {
  exitCode: 0 | 1;
  /** Lines the CLI prints (stdout on success, stderr on rejection). */
  output: string[];
  /** When set, the caller marks gate 3 selection state. */
  selectedCharacterId?: string;
};

/**
 * Execute the choose-character contract against injected ports.
 * Pure decision logic — no process.exit, no filesystem, no network.
 */
export function runChooseCharacter(
  rawCandidate: string | undefined,
  gates: GateStatePort,
  flow: CandidateFlowPort,
): ChooseCharacterResult {
  if (rawCandidate === undefined || rawCandidate === "") {
    return { exitCode: 0, output: [USAGE_CHOOSE_CHARACTER] };
  }

  const selection = parseSelection(rawCandidate);
  if (selection === undefined) {
    return {
      exitCode: 1,
      output: [
        `Invalid selection: ${JSON.stringify(rawCandidate)}`,
        "",
        USAGE_CHOOSE_CHARACTER,
      ],
    };
  }

  if (!gates.isScriptApproved()) {
    return {
      exitCode: 1,
      output: [
        "Gate 2 not passed: approve the script before character selection (spec §3).",
        "Run `mmcs approve script` first.",
      ],
    };
  }

  if (selection.kind === "try-again") {
    const regenerated = flow.regenerateCandidates();
    return {
      exitCode: 0,
      output: [
        "Try Again — previous candidates rejected (kept as draft/rejected, never reusable).",
        "3 NEW candidates created:",
        ...regenerated.candidates.map(
          (c) => `  Character ${c.index}: ${c.characterId}`,
        ),
        "Pick with `mmcs choose-character <1|2|3|4>` (spec §9).",
      ],
    };
  }

  const chosen = flow.selectCandidate(selection.candidateIndex);
  return {
    exitCode: 0,
    output: [
      `Selected Character ${selection.candidateIndex}: ${chosen.characterId} (${chosen.displayName}).`,
      "Character is selected, NOT locked. Lock it with:",
      `  mmcs approve-character ${chosen.characterId}`,
      "(LOCK CHARACTER approval, spec §9).",
    ],
    selectedCharacterId: chosen.characterId,
  };
}

/** Result of one `approve-character` invocation (same output contract). */
export type ApproveCharacterResult = {
  exitCode: 0 | 1;
  output: string[];
};

/** Port over the LOCK CHARACTER transition (CHAR-005 owns the state machine). */
export interface CharacterLockPort {
  /** Mark the character LOCKED/CANONICAL after approval. */
  lockCharacter(characterId: string): void;
}

/**
 * Execute `approve-character <id>`: requires gate 3 (a selection exists) and
 * that the given id IS the selected character. Pure decision logic.
 */
export function runApproveCharacter(
  rawId: string | undefined,
  gates: GateStatePort,
  lock: CharacterLockPort,
): ApproveCharacterResult {
  if (rawId === undefined || rawId === "") {
    return { exitCode: 1, output: [USAGE_APPROVE_CHARACTER] };
  }

  if (!gates.isScriptApproved()) {
    return {
      exitCode: 1,
      output: [
        "Gate 2 not passed: approve the script before character work (spec §3).",
      ],
    };
  }

  if (!gates.hasSelectedCandidate()) {
    return {
      exitCode: 1,
      output: [
        "Gate 3 not satisfied: no character has been selected yet (spec §3, §9).",
        "Run `mmcs cast` then `mmcs choose-character <1|2|3>` first.",
        "",
        USAGE_APPROVE_CHARACTER,
      ],
    };
  }

  const selectedId = gates.getSelectedCharacterId();
  if (selectedId === null || selectedId !== rawId) {
    return {
      exitCode: 1,
      output: [
        `Character ID mismatch: gate 3 selected ${selectedId ?? "<none>"}, not ${JSON.stringify(rawId)}.`,
        "Re-select with `mmcs choose-character <1|2|3>` or approve the selected ID.",
        "",
        USAGE_APPROVE_CHARACTER,
      ],
    };
  }

  lock.lockCharacter(rawId);
  return {
    exitCode: 0,
    output: [
      `LOCK CHARACTER approved: ${rawId} is locked (gate 3 complete, spec §9).`,
      "Next: `mmcs storyboard` (gate 4).",
    ],
  };
}