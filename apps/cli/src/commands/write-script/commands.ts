// `mmcs write-script` + `mmcs approve script` command wiring (spec §24).
//
// DIR-008 owns these two command files. Each exports a CommandSpec override
// that the CORE-011 dispatcher merges over its stub at integration (see
// apps/cli/src/dispatch/registry.ts — mergeSpecs). Handlers run the gate-2
// contract in ./contract.ts against injected ports (the CLI bootstrap binds
// DIR-008's screenplay-approval module + CORE-008's durable store), print the
// result lines, and honor the documented exit codes (0 success, 1 rejection)
// without calling process.exit — the dispatcher owns termination.

import {
  isRejectNote,
  parseApproveScriptOptions,
  stripRejectMarker,
  APPROVE_SCRIPT_SPEC,
  USAGE_APPROVE_SCRIPT,
  USAGE_WRITE_SCRIPT,
  WRITE_SCRIPT_SPEC,
  type ApproveScriptDecision,
  type CommandSpec,
  type ScriptGatePorts,
} from "./contract.js";

export {
  APPROVE_SCRIPT_SPEC,
  WRITE_SCRIPT_SPEC,
  isRejectNote,
  parseApproveScriptOptions,
  stripRejectMarker,
  USAGE_APPROVE_SCRIPT,
  USAGE_WRITE_SCRIPT,
} from "./contract.js";
export type { CommandSpec, ScriptGatePorts, ApproveScriptDecision } from "./contract.js";

/** Ports bundle — supplied by the CLI bootstrap at integration. */
export type WriteScriptCommandPorts = ScriptGatePorts;

/** Print result lines to the right stream; return the exit code for dispatch. */
function emit(lines: string[], exitCode: 0 | 1, stderr = process.stderr): number {
  const stream = exitCode === 0 ? process.stdout : stderr;
  stream.write(lines.join("\n") + "\n");
  return exitCode;
}

/**
 * Handler for `mmcs write-script`.
 * No positional arguments; bare invocation is the whole command.
 */
export function makeWriteScriptHandler(ports: WriteScriptCommandPorts) {
  return (): void => {
    const result = ports.present();
    const code = emit(result.output, result.presented ? 0 : 1);
    if (code === 1) throw new Error("write-script rejected (exit 1)");
  };
}

/**
 * Handler for `mmcs approve script` — records the operator's gate-2 decision.
 * A `--note` starting with "reject:" routes to the REJECTED transition
 * (revision loop, spec §14); plain approval runs the APPROVED transition.
 * `flags` are the raw argv tail; `options` is any pre-parsed subset.
 */
export function makeApproveScriptHandler(ports: WriteScriptCommandPorts) {
  return (options: ApproveScriptDecision = {}, flags: readonly string[] = []): void => {
    const parsed = parseApproveScriptOptions(flags);
    const decision: ApproveScriptDecision = {
      decidedBy: parsed.by ?? options.decidedBy ?? options.by,
      note: parsed.note ?? options.note,
    };
    const result = isRejectNote(decision.note)
      ? ports.rejectScript({ ...decision, note: stripRejectMarker(decision.note) })
      : ports.approveScript(decision);
    const code = emit(result.output, result.exitCode);
    if (code === 1) throw new Error("approve script rejected (exit 1)");
  };
}

// Re-exported for the dispatcher merge test parity with CHAR-004.
export const WRITE_SCRIPT_SPECS: readonly CommandSpec[] = [
  WRITE_SCRIPT_SPEC,
  APPROVE_SCRIPT_SPEC,
];

// Keep the usage constants referenced for the bare-usage paths the dispatcher
// wires when the bootstrap registers these handlers without flags.
void USAGE_WRITE_SCRIPT;
void USAGE_APPROVE_SCRIPT;
