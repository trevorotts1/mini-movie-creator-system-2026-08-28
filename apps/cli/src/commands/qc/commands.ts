// `mmcs qc` command wiring (spec §20, §24) — QC-011.
//
// Owns only this directory (apps/cli/src/commands/qc/). The CLI entry
// (src/index.ts, CORE-011's) gains the real verb via a one-line import at
// integration; that file is NOT owned by QC-011.
//
// The command surfaces the persisted human REVIEW state produced by the
// engine (packages/qc/src/human-review/ — the shot enters REVIEW when the
// automated routes exhaust; spec §20). Default view: the OPEN review queue.
// Subactions:
//
//   mmcs qc                       list open REVIEW items (default)
//   mmcs qc --episode <id>        restrict the listing to one episode
//   mmcs qc --all                 include resolved (APPROVED/REJECTED) items
//   mmcs qc approve <shotId>      record a human APPROVED decision (--by required)
//   mmcs qc reject <shotId>       record a human REJECTED decision (--by required)
//
// NO SILENT AUTO-APPROVAL (task QC-011, spec §19/§20): approve/reject REQUIRE
// --by <human>; without it the command exits 1 and writes nothing — the human
// REVIEW state can only ever be resolved by a recorded human decision, never
// by the absence of a reviewer, a timeout, or a config default.
//
// Exit codes: 0 ok (listing may be empty — that is exit 0 with zero rows);
// 1 rejection (unknown shot, illegal transition, missing --by); 2 usage error.
// Story/script text is untrusted and is never executed — ids/notes are
// compared and echoed as inert data (§29).

/** Command-spec shape for the CORE-011 dispatcher (mergeSpecs). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const QC_SPEC: CommandSpec = {
  name: "qc",
  description:
    "Run/inspect QC: lists human REVIEW items; approve/reject resolve them (spec §20)",
  group: "generation",
};

export const USAGE_QC = [
  "Usage: mmcs qc [subaction] [options]",
  "",
  "Surfaces the persisted human REVIEW state (spec §20): shots whose",
  "automated routes are exhausted wait here for a human decision —",
  "nothing is ever auto-approved.",
  "",
  "Subactions:",
  "  (default)             list open human REVIEW items",
  "  approve <shotId>      record a human APPROVED decision",
  "  reject <shotId>       record a human REJECTED decision",
  "",
  "Options:",
  "  --episode <id>        restrict the listing to one episode",
  "  --all                 include resolved (APPROVED/REJECTED) items",
  "  --by <human>          who decided (REQUIRED for approve/reject)",
  "  --note <text>         decision note",
  "  --json                emit the result as one JSON line for scripting",
].join("\n");

/** Parsed long-option set for the qc command. */
export interface QcOptions {
  readonly episode?: string;
  readonly by?: string;
  readonly note?: string;
  readonly all?: boolean;
  readonly json?: boolean;
  /** True when an option was malformed/unknown/missing its value. */
  readonly parseError?: string;
}

const VALUE_OPTIONS = ["episode", "by", "note"] as const;

export function parseQcOptions(argv: readonly string[]): QcOptions {
  const out: {
    episode?: string;
    by?: string;
    note?: string;
    all?: boolean;
    json?: boolean;
    parseError?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--all") {
      out.all = true;
      continue;
    }
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
    if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
      if (name === "episode") out.episode = value;
      else if (name === "by") out.by = value;
      else if (name === "note") out.note = value;
    } else {
      out.parseError = `unknown option: --${name}`;
      return out;
    }
  }
  return out;
}

/**
 * Structural view of one human-review record (the engine's persisted row).
 * Declared locally so the command compiles against the store's shape without
 * a runtime dependency at parse time — identical fields, do not diverge.
 */
export interface HumanReviewRecordLike {
  readonly shotId: string;
  readonly episodeId: string;
  readonly sceneId: string | null;
  readonly attempt: number;
  readonly trigger: string;
  readonly reason: string;
  readonly routesTried: readonly string[];
  readonly state: string;
  readonly enteredAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly note: string | null;
}

/**
 * Ports over the durable state — injected by the CLI bootstrap at
 * integration. No IO in this module itself.
 */
export interface QcCommandPorts {
  /** Open (or all) human-review records, oldest-entered first. */
  listReviews(query: { episodeId?: string; includeResolved?: boolean }): Promise<HumanReviewRecordLike[]>;
  /** Record a human APPROVED decision; throws on unknown/illegal. */
  approve(shotId: string, decision: { decidedBy: string; note?: string }): Promise<HumanReviewRecordLike>;
  /** Record a human REJECTED decision; throws on unknown/illegal. */
  reject(shotId: string, decision: { decidedBy: string; note?: string }): Promise<HumanReviewRecordLike>;
}

export interface QcCommandResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
  json?: unknown;
}

function formatRecord(rec: HumanReviewRecordLike): string {
  const routes = rec.routesTried.length > 0 ? ` after ${rec.routesTried.join(" → ")}` : "";
  const scene = rec.sceneId ? ` (${rec.sceneId})` : "";
  const decided =
    rec.state === "REVIEW"
      ? `attempt ${rec.attempt}, entered ${rec.enteredAt}`
      : `${rec.state} by ${rec.decidedBy ?? "?"} at ${rec.decidedAt ?? "?"}`;
  return [
    `${rec.state} ${rec.shotId}${scene} — ${decided}`,
    `  episode: ${rec.episodeId} · trigger: ${rec.trigger}${routes}`,
    `  why: ${rec.reason}`,
    rec.note ? `  note: ${rec.note}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Execute the qc command logic. Async: the durable store is async. Pure
 * orchestration over injected ports; the only I/O lives in the ports.
 */
export async function runQc(
  subaction: string | undefined,
  positional: readonly string[],
  rawOptions: readonly string[],
  ports: QcCommandPorts,
): Promise<QcCommandResult> {
  if (subaction !== undefined && subaction !== "approve" && subaction !== "reject") {
    return {
      exitCode: 2,
      lines: [`[mmcs] qc: unknown subaction "${subaction}"`, USAGE_QC],
    };
  }
  const options = parseQcOptions(rawOptions);
  if (options.parseError !== undefined) {
    return { exitCode: 2, lines: [`[mmcs] qc: ${options.parseError}`, USAGE_QC] };
  }

  const decide = async (
    verb: "approve" | "reject",
  ): Promise<QcCommandResult> => {
    const shotId = positional[0];
    if (shotId === undefined || shotId.trim() === "") {
      return { exitCode: 2, lines: [`[mmcs] qc ${verb} requires a <shotId>`, USAGE_QC] };
    }
    // NO SILENT AUTO-APPROVAL: a decision without a recorded human is a
    // rejection at the CLI boundary before the store is ever touched.
    if (options.by === undefined || options.by.trim() === "") {
      return {
        exitCode: 1,
        lines: [
          `[mmcs] qc ${verb}: --by <human> is required — the human REVIEW state can only be resolved by a recorded human decision (no auto-approval)`,
        ],
      };
    }
    try {
      const decision = {
        decidedBy: options.by.trim(),
        ...(options.note !== undefined ? { note: options.note } : {}),
      };
      const record = verb === "approve"
        ? await ports.approve(shotId.trim(), decision)
        : await ports.reject(shotId.trim(), decision);
      const lines = [
        `[mmcs] qc ${verb} ${record.shotId} — ${record.state} by ${record.decidedBy}${record.decidedAt ? ` at ${record.decidedAt}` : ""}`,
        ...(record.note ? [`[mmcs] qc note: ${record.note}`] : []),
      ];
      if (options.json) {
        const json = { subaction: verb, shotId: record.shotId, state: record.state, decidedBy: record.decidedBy, decidedAt: record.decidedAt, note: record.note };
        lines.push(JSON.stringify(json));
        return { exitCode: 0, lines, json };
      }
      return { exitCode: 0, lines };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, lines: [`[mmcs] qc ${verb}: ${message}`] };
    }
  };

  if (subaction === "approve") return decide("approve");
  if (subaction === "reject") return decide("reject");

  // Default: surface the open REVIEW queue (spec §20 human REVIEW state).
  const reviews = await ports.listReviews({
    ...(options.episode !== undefined ? { episodeId: options.episode } : {}),
    includeResolved: options.all === true,
  });
  const open = reviews.filter((r) => r.state === "REVIEW");
  const lines = [
    `[mmcs] qc — human REVIEW items${options.episode ? ` for ${options.episode}` : ""}: ${open.length} open (nothing is auto-approved; each waits for a recorded human decision)`,
  ];
  for (const rec of reviews) {
    lines.push(formatRecord(rec));
  }
  if (reviews.length === 0) {
    lines.push("[mmcs] qc — no human REVIEW items; automated QC has no open escalations");
  }
  if (options.json) {
    const json = {
      openCount: open.length,
      items: reviews.map((r) => ({
        shotId: r.shotId,
        episodeId: r.episodeId,
        sceneId: r.sceneId,
        attempt: r.attempt,
        trigger: r.trigger,
        reason: r.reason,
        routesTried: [...r.routesTried],
        state: r.state,
        enteredAt: r.enteredAt,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedBy,
        note: r.note,
      })),
    };
    lines.push(JSON.stringify(json));
    return { exitCode: 0, lines, json };
  }
  return { exitCode: 0, lines };
}

/**
 * Wire the real handler for the CORE-011 dispatcher (mergeSpecs).
 *
 * The dispatcher surface is the LISTING (`mmcs qc` — what the acceptance
 * requires: surface REVIEW items). Approve/reject run through runQc directly
 * (the dispatcher's argument wiring has no optional positional slot; the API
 * boundary keeps the full subaction surface for tests and the future app).
 */
export function makeQcHandler(ports: QcCommandPorts) {
  return async (args: Record<string, string>, options: Record<string, unknown>): Promise<void> => {
    const rawOptions = Object.entries(options).flatMap(([k, v]) =>
      v === true ? [`--${k}`] : [`--${k}`, String(v)],
    );
    const result = await runQc(undefined, [], rawOptions, ports);
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(result.lines.join("\n") + "\n");
    if (result.exitCode !== 0) {
      throw new Error(`qc rejected (exit ${result.exitCode})`);
    }
    void args;
  };
}
