// `mmcs develop-concept` + `mmcs approve concept` command wiring (spec §24).
//
// DIR-003 owns these two command files. Each exports a CommandSpec override
// the CORE-011 dispatcher merges over its stub at integration (see
// apps/cli/src/dispatch/registry.ts — mergeSpecs; the same seam CHAR-004 /
// VID-013 / CORE-015 use). Handlers run the pure contract in
// ../develop-concept/contract.ts against injected ports, print result lines,
// and return the documented exit codes (0 success, 1 gate rejection, 2 usage
// error) — they never call process.exit; the dispatcher owns termination.

import {
  APPROVE_CONCEPT_SPEC,
  DEVELOP_CONCEPT_SPEC,
  parseApproveConceptOptions,
  runApproveConcept,
  runDevelopConcept,
  USAGE_APPROVE_CONCEPT,
  USAGE_DEVELOP_CONCEPT,
  type ApproveConceptOptions,
  type CommandSpec,
  type DevelopConceptPorts,
} from "../develop-concept/contract.js";

export type {
  ApproveConceptOptions,
  CommandSpec,
  ConceptCommandResult,
  ConceptDraftLike,
  DevelopConceptPorts,
} from "../develop-concept/contract.js";
export {
  APPROVE_CONCEPT_SPEC,
  DEVELOP_CONCEPT_SPEC,
  USAGE_APPROVE_CONCEPT,
  USAGE_DEVELOP_CONCEPT,
  parseApproveConceptOptions,
  runApproveConcept,
  runDevelopConcept,
} from "../develop-concept/contract.js";

/** Ports bundle — supplied by the CLI bootstrap at integration. */
export interface ConceptCommandPorts extends DevelopConceptPorts {}

/** Print result lines to the right stream; return the exit code for dispatch. */
function emit(
  lines: string[],
  exitCode: 0 | 1 | 2,
  stderr = process.stderr,
): number {
  const stream = exitCode === 0 ? process.stdout : stderr;
  stream.write(lines.join("\n") + "\n");
  return exitCode;
}

/**
 * Handler for `mmcs develop-concept`. Signature matches the CORE-011
 * dispatcher's wire (`handler(args, options)`). Bare invocation prints usage
 * and exits 0 (discoverability); the real run presents the developed concept
 * and STOPS at gate 1.
 */
export function makeDevelopConceptHandler(ports: ConceptCommandPorts) {
  return async (
    _args: Record<string, string>,
    rawOptions: Record<string, unknown> = {},
  ): Promise<number> => {
    const options = parseApproveConceptOptions(rawOptions);
    if (options.help) {
      return emit([USAGE_DEVELOP_CONCEPT], 0);
    }
    const result = await runDevelopConcept(ports);
    return emit(result.output, result.exitCode);
  };
}

/**
 * Handler for `mmcs approve concept <flags>`. Signature matches the CORE-011
 * dispatcher's wire (`handler(args, options)`): positional args first, the
 * options record (or Command-like `getOptionValue` instance at integration)
 * second. Parses the documented flags, applies the operator decision through
 * the contract, and emits the outcome.
 */
export function makeApproveConceptHandler(ports: ConceptCommandPorts) {
  return async (
    _args: Record<string, string>,
    rawOptions: Record<string, unknown> = {},
  ): Promise<number> => {
    const options: ApproveConceptOptions = parseApproveConceptOptions(rawOptions);
    if (options.help) {
      return emit([USAGE_APPROVE_CONCEPT], 0);
    }
    const result = await runApproveConcept(options, ports);
    const code = emit(result.output, result.exitCode);
    if (code !== 0) {
      // The dispatcher invokes handlers fire-and-forget (`void handler(...)`);
      // surface the refusal as a non-zero process exit, mirroring CORE-015.
      process.exitCode = code;
    }
    return code;
  };
}

/** The specs this task hands to the batch merger (base-registry overrides). */
export const CONCEPT_COMMAND_SPECS: readonly CommandSpec[] = [
  DEVELOP_CONCEPT_SPEC,
  APPROVE_CONCEPT_SPEC,
];
