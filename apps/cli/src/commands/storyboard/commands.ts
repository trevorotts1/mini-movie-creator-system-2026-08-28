// `mmcs storyboard` + `mmcs approve-storyboard` command wiring (spec §24,
// §3 gate 4) — DIR-015.
//
// Owns only this directory (apps/cli/src/commands/storyboard/). The CLI
// entry (src/index.ts, CORE-011's) gains the real verbs via CommandSpec
// overrides merged over the stubs at integration (see
// apps/cli/src/dispatch/registry.ts — mergeSpecs); that file is NOT owned
// by DIR-015.
//
// The commands:
//   - `mmcs storyboard` plans the episode's storyboard/keyframe contracts
//     through the engine's pure planner and STOPS at gate 4 — it prints the
//     per-shot plan and the approval instruction, never triggers paid
//     generation;
//   - `mmcs approve-storyboard` advances the persisted gate-4 record
//     PENDING → APPROVED through the injected approval store (earlier gates
//     enforced there) and marks the plan APPROVED in the same breath;
//   - `mmcs approve-storyboard --reject "<note>"` records a REJECTED gate
//     decision and holds the plan at DRAFT for revision (spec §3 state
//     machine — a rejected gate returns through reopen, never a flip).
//
// The gate module (packages/scene-intelligence/src/storyboard/approval/)
// owns the engine-side stop condition; the generation phase must call
// `assertPaidGenerationAllowed` before any real image client. These CLI
// verbs read the gate snapshot and never spend.
//
// Exit codes (documented, scriptable): 0 success, 1 rejection (plan not
// found, gate-order/transition error from the store), 2 usage error.
//
// Local-type pattern (same as CHAR-004/CAP-009): this command does NOT
// import @mmcs/scene-intelligence. `apps/cli/tsconfig.json` pins
// `rootDir: src`, so a workspace import pulls package sources outside the
// CLI's rootDir and fails typecheck with TS6059. Types below are
// structurally identical to the package's storyboard/approval exports —
// the package remains the canonical engine; integration wiring feeds this
// command through the same shapes. Do not diverge.

/** Command-spec shape for the CORE-011 dispatcher (mergeSpecs). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const STORYBOARD_GROUP = "storyboard";

export const STORYBOARD_SPEC: CommandSpec = {
  name: "storyboard",
  description:
    "Generate the storyboard/keyframe plan and STOP for storyboard approval (gate 4, spec §3)",
  group: STORYBOARD_GROUP,
};

export const APPROVE_STORYBOARD_SPEC: CommandSpec = {
  name: "approve-storyboard",
  description: "Approve the storyboard (gate 4) — unlocks paid generation",
  group: STORYBOARD_GROUP,
};

export const USAGE_STORYBOARD = [
  "Usage: mmcs storyboard [options]",
  "",
  "Plans the episode's storyboard/keyframe contracts and STOPS at gate 4:",
  "no paid generation happens while the storyboard is unapproved (spec §3).",
  "Prints one line per planned shot plus the approval instruction.",
  "",
  "Options:",
  "  --episode <code>    episode code, e.g. S01E01 (required)",
  "  --aspect <ratio>    production aspect ratio (default 16:9)",
  "  --json              emit the plan summary as one JSON line for scripting",
].join("\n");

export const USAGE_APPROVE_STORYBOARD = [
  "Usage: mmcs approve-storyboard [options]",
  "",
  "Records the gate-4 storyboard decision in the durable approval store.",
  "",
  "  approve:  plan → APPROVED, persisted gate → APPROVED (gate order",
  "            concept → script → character → storyboard enforced)",
  "  reject:   --reject \"<note>\" — gate → REJECTED, plan held at DRAFT",
  "            for revision; re-approval presents the revised plan again",
  "",
  "Paid generation stays blocked until BOTH the plan and the persisted",
  "gate-4 record read APPROVED.",
].join("\n");

/* ------------------------------------------------------------------ */
/* Structural engine types (mirror the approval-gate module — do not   */
/* diverge: packages/scene-intelligence/src/storyboard/approval/)      */
/* ------------------------------------------------------------------ */

export type GateStateLike = "PENDING" | "APPROVED" | "REJECTED";

export interface GateSnapshotLike {
  gate: string;
  state: GateStateLike;
  approvedAt: string | null;
  rejectedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface GateDecisionInputLike {
  decidedBy?: string;
  note?: string;
  now?: string;
}

/**
 * Structural port over the durable approval store (core `ApprovalStore`
 * subset: approve/reject/snapshot). Supplied by the CLI bootstrap at
 * integration; tests inject an in-memory implementation.
 */
export interface StoryboardApprovalPortLike {
  approve(
    gate: string,
    decision?: GateDecisionInputLike,
  ): Promise<{ state: string }>;
  reject(
    gate: string,
    decision?: GateDecisionInputLike,
  ): Promise<{ state: string }>;
  snapshot(gate: string): Promise<GateSnapshotLike>;
}

/** One planned-shot summary line the engine planner produces. */
export interface StoryboardPlanSummaryLike {
  episodeCode: string;
  aspectRatio: string;
  approvalState: "DRAFT" | "APPROVED";
  contractCount: number;
  shotIds: readonly string[];
  skippedShotIds: readonly string[];
}

/** Ports bundle — injected by the CLI bootstrap at integration. */
export interface StoryboardCommandPorts {
  /**
   * Plan (or reload) the current episode's storyboard contracts through
   * the engine's pure planner. Returns undefined when there is nothing to
   * plan yet (no shots — the caller reports exit 1). `aspect` carries the
   * operator's `--aspect` override when given (the planner's production
   * aspect ratio; undefined = planner default).
   */
  loadPlan(
    episodeCode: string,
    aspect?: string,
  ): StoryboardPlanSummaryLike | undefined;
  /** The durable approval store (spec §3 gate records). */
  gates: StoryboardApprovalPortLike;
}

/** Result of one command invocation. */
export interface StoryboardCommandResult {
  exitCode: 0 | 1 | 2;
  /** Lines the CLI prints (stdout on success, stderr on rejection). */
  lines: string[];
  /** One JSON line under --json. */
  json?: unknown;
}

const GATE = "storyboard";

/**
 * Parse `argv` (verb and positionals already stripped) into options.
 * Unknown flags are a usage error — scriptable, never permissive (spec §24).
 */
export function parseStoryboardOptions(
  argv: readonly string[],
): { episode?: string; aspect?: string; json?: boolean; rejectNote?: string; parseError?: string } {
  const out: {
    episode?: string;
    aspect?: string;
    json?: boolean;
    rejectNote?: string;
    parseError?: string;
  } = {};
  const knownWithValue = new Set(["episode", "aspect", "reject"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (!token.startsWith("--")) {
      out.parseError = `unexpected argument: ${token}`;
      return out;
    }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out.parseError = `option --${name} requires a value`;
      return out;
    }
    i++;
    if (!knownWithValue.has(name)) {
      out.parseError = `unknown option: --${name}`;
      return out;
    }
    if (name === "episode") out.episode = value;
    else if (name === "aspect") out.aspect = value;
    else if (name === "reject") out.rejectNote = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* `mmcs storyboard` — plan, then STOP at gate 4                       */
/* ------------------------------------------------------------------ */

/**
 * Execute `mmcs storyboard`. Pure orchestration over injected ports — the
 * only I/O lives in the ports. Never touches a provider, never spends.
 */
export async function runStoryboardCommand(
  rawOptions: readonly string[],
  ports: StoryboardCommandPorts,
): Promise<StoryboardCommandResult> {
  const options = parseStoryboardOptions(rawOptions);
  if (options.parseError !== undefined) {
    return {
      exitCode: 2,
      lines: [`[mmcs] storyboard: ${options.parseError}`, USAGE_STORYBOARD],
    };
  }
  if (options.episode === undefined || options.episode.trim() === "") {
    return {
      exitCode: 2,
      lines: [
        "[mmcs] storyboard: --episode <code> is required (e.g. --episode S01E01)",
        USAGE_STORYBOARD,
      ],
    };
  }
  const episodeCode = options.episode.trim();
  const plan = ports.loadPlan(episodeCode, options.aspect);
  if (plan === undefined) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] storyboard: no shot plan available for ${episodeCode} — plan scenes/shots first (runbook step 12/13)`,
      ],
    };
  }
  const snapshot = await ports.gates.snapshot(GATE);
  return formatStoryboardOutput(options, plan, snapshot);
}

/**
 * Shared output formatter: plan lines + the gate-4 STOP banner + optional
 * JSON line. Kept pure so tests assert the exact operator-facing contract.
 */
export function formatStoryboardOutput(
  options: { aspect?: string; json?: boolean },
  plan: StoryboardPlanSummaryLike,
  snapshot: GateSnapshotLike | undefined,
): StoryboardCommandResult {
  const lines = [
    `[mmcs] storyboard ${plan.episodeCode} — ${plan.contractCount} frame contract(s) at ${plan.aspectRatio}`,
    ...plan.shotIds.map((id) => `[mmcs] storyboard — planned shot ${id}`),
    ...(plan.skippedShotIds.length > 0
      ? [
          `[mmcs] storyboard — skipped (no frame needed): ${plan.skippedShotIds.join(", ")}`,
        ]
      : []),
    `[mmcs] storyboard — STOP: gate 4 (storyboard approval, spec §3). ` +
      `No paid generation while the storyboard is unapproved.`,
    `[mmcs] storyboard — approve with: mmcs approve-storyboard --episode ${plan.episodeCode}`,
  ];
  if (snapshot !== undefined) {
    lines.push(
      `[mmcs] storyboard — gate state: ${snapshot.state}` +
        (snapshot.note !== null ? ` (note: ${snapshot.note})` : ""),
    );
  }
  if (options.json) {
    const json = {
      episodeCode: plan.episodeCode,
      aspectRatio: plan.aspectRatio,
      approvalState: plan.approvalState,
      contractCount: plan.contractCount,
      shotIds: [...plan.shotIds],
      skippedShotIds: [...plan.skippedShotIds],
      gate: snapshot?.state ?? null,
      stop: "storyboard-approval-gate-4",
    };
    lines.push(JSON.stringify(json));
    return { exitCode: 0, lines, json };
  }
  return { exitCode: 0, lines };
}

/* ------------------------------------------------------------------ */
/* `mmcs approve-storyboard` — record the gate-4 decision              */
/* ------------------------------------------------------------------ */

/**
 * Execute `mmcs approve-storyboard`. Awaitable: the durable store is async.
 * Approve (default) or reject via `--reject "<note>"`. The engine-side
 * planner marks the plan from the same decision — this command only ever
 * reads the plan summary for the output lines.
 */
export async function runApproveStoryboard(
  rawOptions: readonly string[],
  ports: StoryboardCommandPorts,
): Promise<StoryboardCommandResult> {
  const options = parseStoryboardOptions(rawOptions);
  if (options.parseError !== undefined) {
    return {
      exitCode: 2,
      lines: [
        `[mmcs] approve-storyboard: ${options.parseError}`,
        USAGE_APPROVE_STORYBOARD,
      ],
    };
  }
  if (options.episode === undefined || options.episode.trim() === "") {
    return {
      exitCode: 2,
      lines: [
        "[mmcs] approve-storyboard: --episode <code> is required (e.g. --episode S01E01)",
        USAGE_APPROVE_STORYBOARD,
      ],
    };
  }
  const episodeCode = options.episode.trim();
  const plan = ports.loadPlan(episodeCode);
  if (plan === undefined) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] approve-storyboard: no storyboard plan available for ${episodeCode} — run \`mmcs storyboard --episode ${episodeCode}\` first`,
      ],
    };
  }
  if (plan.approvalState === "APPROVED") {
    return {
      exitCode: 1,
      lines: [
        options.rejectNote === undefined
          ? `[mmcs] approve-storyboard: storyboard for ${episodeCode} is already APPROVED — reopen the gate and re-present a revised plan to change the decision (spec §3: never flip in one step)`
          : `[mmcs] approve-storyboard: storyboard for ${episodeCode} is already APPROVED — reopen the gate before rejecting (spec §3: never flip a decision in one step)`,
      ],
    };
  }

  const decision: GateDecisionInputLike = {
    decidedBy: "trevor", // operator identity for gate records
    ...(options.rejectNote !== undefined ? { note: options.rejectNote } : {}),
  };

  const record = options.rejectNote !== undefined
    ? await ports.gates.reject(GATE, { ...decision, note: options.rejectNote })
    : await ports.gates.approve(GATE, decision);

  if (record.state !== (options.rejectNote !== undefined ? "REJECTED" : "APPROVED")) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] approve-storyboard: approval store returned state ${record.state} for gate "${GATE}" — refusing to report success`,
      ],
    };
  }

  const snapshot = await ports.gates.snapshot(GATE);
  const verb = options.rejectNote !== undefined ? "REJECTED" : "APPROVED";
  const lines = [
    `[mmcs] approve-storyboard ${episodeCode} — gate 4 ${verb}`,
    ...(options.rejectNote !== undefined
      ? [
          `[mmcs] approve-storyboard — plan held at DRAFT for revision; re-approval presents the revised plan (spec §3)`,
        ]
      : []),
    `[mmcs] approve-storyboard — persisted gate state: ${snapshot.state}` +
      (snapshot.note !== null ? ` (note: ${snapshot.note})` : ""),
    ...(options.rejectNote === undefined
      ? [
          `[mmcs] approve-storyboard — paid generation may proceed: plan APPROVED + gate APPROVED (gate 4 satisfied)`,
        ]
      : [
          `[mmcs] approve-storyboard — paid generation remains BLOCKED while the storyboard is unapproved (spec §3)`,
        ]),
  ];
  if (options.json) {
    const json = {
      episodeCode,
      decision: verb,
      note: options.rejectNote ?? null,
      gateState: snapshot.state,
      planApprovalState: plan.approvalState,
    };
    lines.push(JSON.stringify(json));
    return { exitCode: 0, lines, json };
  }
  return { exitCode: 0, lines };
}

/* ------------------------------------------------------------------ */
/* Dispatcher wiring                                                   */
/* ------------------------------------------------------------------ */

/** Wire the real handlers for the CORE-011 dispatcher (mergeSpecs). */
export function makeStoryboardHandlers(ports: StoryboardCommandPorts): Record<
  string,
  (args: Record<string, string>, options: Record<string, unknown>) => void | Promise<void>
> {
  const emit = (result: StoryboardCommandResult): void => {
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(result.lines.join("\n") + "\n");
  };
  /**
   * Extract option values from a commander Command instance when present.
   * The current CORE-011 wire passes `{}` as options, so without this the
   * flags never reach the handler and bare `mmcs storyboard` is a usage
   * error — the same documented fallback as CORE-015's backup commands.
   */
  const readOptions = (options: Record<string, unknown>): string[] => {
    const getValue = (options as { getOptionValue?: (k: string) => unknown })
      .getOptionValue;
    if (typeof getValue !== "function") return [];
    const tokens: string[] = [];
    const push = (flag: string, v: unknown): void => {
      if (v === true) tokens.push(`--${flag}`);
      else if (typeof v === "string") tokens.push(`--${flag}`, v);
    };
    push("episode", getValue.call(options, "episode"));
    push("aspect", getValue.call(options, "aspect"));
    push("reject", getValue.call(options, "reject"));
    push("json", getValue.call(options, "json"));
    return tokens;
  };
  return {
    storyboard: (_args, options) => {
      runStoryboardCommand(readOptions(options), ports)
        .then((result) => {
          emit(result);
          if (result.exitCode !== 0) {
            throw new Error(`storyboard rejected (exit ${result.exitCode})`);
          }
        })
        .catch((err: unknown) => {
          // The dispatcher invokes handlers fire-and-forget (`void handler(...)`)
          // — an async throw would surface as an unhandled rejection with a raw
          // stack instead of the command's clean failure. Record the exit code
          // so the process terminates non-zero (same pattern as CORE-015).
          process.exitCode = 1;
          process.stderr.write(
            `[mmcs] storyboard: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    },
    "approve-storyboard": (_args, options) => {
      runApproveStoryboard(readOptions(options), ports)
        .then((result) => {
          emit(result);
          if (result.exitCode !== 0) {
            throw new Error(
              `approve-storyboard rejected (exit ${result.exitCode})`,
            );
          }
        })
        .catch((err: unknown) => {
          process.exitCode = 1;
          process.stderr.write(
            `[mmcs] approve-storyboard: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    },
  };
}
