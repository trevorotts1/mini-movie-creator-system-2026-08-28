// `mmcs choose-character` + `mmcs approve-character` command wiring (spec §24).
//
// CHAR-004 owns these two command files. Each exports a CommandSpec override
// that the CORE-011 dispatcher merges over its stub at integration (see
// apps/cli/src/dispatch/registry.ts — mergeSpecs). Handlers run the pure
// contract in ../choose-character/contract.ts against real ports, print the
// result lines, and honor the documented exit codes (0 success, 1 rejection)
// without calling process.exit — the dispatcher owns termination.

import {
  runApproveCharacter,
  runChooseCharacter,
  USAGE_APPROVE_CHARACTER,
  USAGE_CHOOSE_CHARACTER,
  type CandidateFlowPort,
  type CharacterLockPort,
  type CommandSpec,
  type GateStatePort,
} from "../choose-character/contract.js";

/** Ports bundle — supplied by the CLI bootstrap at integration. */
export interface CharacterCommandPorts {
  gates: GateStatePort;
  flow: CandidateFlowPort;
  lock: CharacterLockPort;
}

export const CHOOSE_CHARACTER_SPEC: CommandSpec = {
  name: "choose-character",
  description: "Choose Character 1/2/3 or 4=Try Again (gate 3, spec §9)",
  args: ["<candidate>"],
  group: "characters",
};

export const APPROVE_CHARACTER_SPEC: CommandSpec = {
  name: "approve-character",
  description: "LOCK CHARACTER approval after gate 3 selection (spec §9)",
  args: ["<id>"],
  group: "characters",
};

/** Print result lines to the right stream; return the exit code for dispatch. */
function emit(lines: string[], exitCode: 0 | 1, stderr = process.stderr): number {
  const stream = exitCode === 0 ? process.stdout : stderr;
  stream.write(lines.join("\n") + "\n");
  return exitCode;
}

/**
 * Handler for `mmcs choose-character <candidate>`.
 * Bare invocation (no argument) prints usage and exits 0 — discoverability;
 * invalid selections print usage and exit 1.
 */
export function makeChooseCharacterHandler(ports: CharacterCommandPorts) {
  return (args: Record<string, string>): void | Promise<void> => {
    const raw = args.candidate;
    if (raw === undefined) {
      emit([USAGE_CHOOSE_CHARACTER], 0);
      return;
    }
    const result = runChooseCharacter(raw, ports.gates, ports.flow);
    const code = emit(result.output, result.exitCode);
    if (code === 1) throw new Error("choose-character rejected (exit 1)");
    // Gate-3 selection state is recorded by the injected ports; when the
    // durable gate store lands (CORE-008/CORE-014) the bootstrap wires this
    // selectedCharacterId through ports.gates. Contract-level test coverage
    // asserts the value here so integration cannot lose it.
    void result.selectedCharacterId;
  };
}

/** Handler for `mmcs approve-character <id>` — requires gate 3 (spec §3). */
export function makeApproveCharacterHandler(ports: CharacterCommandPorts) {
  return (args: Record<string, string>): void | Promise<void> => {
    const result = runApproveCharacter(args.id, ports.gates, ports.lock);
    const code = emit(result.output, result.exitCode);
    if (code === 1) throw new Error("approve-character rejected (exit 1)");
  };
}