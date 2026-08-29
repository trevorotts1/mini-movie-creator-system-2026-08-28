// Script-gate CLI contract — `mmcs write-script` + `mmcs approve script`
// (spec §24, §3 gate 2). DIR-008 owns these two verbs.
//
// This layer is pure: parsing, validation, and the state transitions the CLI
// surface drives, against INJECTED PORTS. The gate decision domain lives in
// DIR-008's `packages/scene-intelligence/src/screenplay/approval/`
// (presenter.ts + guard.ts) and the durable six-gate store in CORE-008; the
// CLI bootstrap wires them into these ports at integration. The CLI never
// imports `@mmcs/scene-intelligence` directly — `apps/cli/tsconfig.json`
// pins `rootDir: src`, so any cross-package import would not compile (the
// same local-type pattern providers-verify and CHAR-004 use). The port
// result shapes below mirror the package's `PresentationResult` /
// `ApprovalDecisionResult` structurally; do not diverge.

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

export const WRITE_SCRIPT_SPEC: CommandSpec = {
  name: "write-script",
  description: "Write the script for the episode (STOP at script gate)",
  group: "approvals",
};

export const APPROVE_SCRIPT_SPEC: CommandSpec = {
  name: "approve script",
  description: "Approve the written script (gate 2, spec §3)",
  group: "approvals",
};

export const USAGE_WRITE_SCRIPT = [
  "Usage: mmcs write-script",
  "",
  "Generates the episode screenplay from the approved concept (gate 1) and",
  "presents it for approval. Requires the script QC verdict to be \"pass\"",
  "(spec §3: screenplay generated AND QC'd).",
  "",
  "STOP: after this command the pipeline waits at gate 2 — run",
  "`mmcs approve script` to proceed (no cast/candidate work before approval).",
].join("\n");

export const USAGE_APPROVE_SCRIPT = [
  "Usage: mmcs approve script [--by <operator>] [--note <text>]",
  "",
  "Records the operator's gate-2 sign-off on the presented screenplay.",
  "A note starting with \"reject:\" sends the script back for revision",
  "(spec §14). Run `mmcs write-script` first; then approve to unlock",
  "cast/candidate work (spec §3: no cast/candidate work before approval).",
].join("\n");

/** Local mirror of the gate-2 record the decision ports return. */
export interface ScriptGateRecordLike {
  screenplayId: string;
  state: "PENDING" | "APPROVED" | "REJECTED";
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

/** Decision payload parsed from `mmcs approve script` flags. */
export interface ApproveScriptDecision {
  /** Operator identity (`--by`); recorded with the decision. */
  by?: string;
  /** Alias matching the package's `decidedBy` naming. */
  decidedBy?: string;
  note?: string;
}

/** Ports over the gate-2 domain (package + CORE-008 store), injected. */
export interface ScriptGatePorts {
  /** Present the QC-passed screenplay for approval (`write-script`). */
  present(): { presented: boolean; output: string[]; record: ScriptGateRecordLike | null };
  /** Record the operator's APPROVED decision at gate 2. */
  approveScript(decision: ApproveScriptDecision): {
    exitCode: 0 | 1;
    output: string[];
    record: ScriptGateRecordLike | null;
  };
  /** Record the operator's REJECTED decision at gate 2 (revision loop). */
  rejectScript(decision: ApproveScriptDecision): {
    exitCode: 0 | 1;
    output: string[];
    record: ScriptGateRecordLike | null;
  };
}

/** Parse `--by <operator>` / `--note <text>` flag pairs from raw argv tails. */
export function parseApproveScriptOptions(
  flags: readonly string[],
): ApproveScriptDecision & { unknown: string[] } {
  const opts: ApproveScriptDecision & { unknown: string[] } = { unknown: [] };
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--by") {
      const value = flags[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        opts.by = value;
        i += 1;
      }
      continue;
    }
    if (flag === "--note") {
      const value = flags[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        opts.note = value;
        i += 1;
      }
      continue;
    }
    if (typeof flag === "string") opts.unknown.push(flag);
  }
  return opts;
}

/** True when an operator note routes the decision to REJECTED (revision). */
export function isRejectNote(note: string | undefined): boolean {
  return (note ?? "").toLowerCase().startsWith("reject:");
}

/** Strip the "reject:" marker from an operator note. */
export function stripRejectMarker(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  return isRejectNote(note) ? note.slice("reject:".length).trim() : note.trim();
}
