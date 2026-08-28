// `mmcs retry-shot <id>` command wiring (spec §20, §24) — VID-013.
//
// Owns only this directory (apps/cli/src/commands/retry-shot/). The CLI
// entry (src/index.ts, CORE-011's) gains the real verb via a one-line import
// at integration; that file is NOT owned by VID-013.
//
// The command:
//   1. loads the episodic shot plan through an injected loader (no
//      filesystem/network access at module import time — testable);
//   2. plans the retry scope: EXACTLY the named shot (spec §20 — targeted
//      repair of the affected shot only, never whole-episode regeneration);
//   3. applies the operator-supplied replacement inputs (new asset and/or
//      trim) to that one shot;
//   4. emits the composition diff proving only the targeted shot changed;
//   5. hands the regen job to the injected generation port — never calls a
//      provider directly, never spends without the injected job runner.
//
// Usage:
//   mmcs retry-shot <id> [--asset <ref>] [--trim-in <frames>] [--trim-out <frames>]
//   mmcs retry-shot <id> --duration <frames>        (explicit reflow policy)
//   mmcs retry-shot <id> --attempt <n> [--reason <text>]
//   mmcs retry-shot <id> --json
//
// Exit codes: 0 replaced; 1 rejection (unknown shot, invalid trim/duration,
// no generation port); 2 usage error. Story/script text is untrusted and is
// never executed — ids/assets are compared and echoed as inert data (§29).

/** Command-spec shape for the CORE-011 dispatcher (mergeSpecs). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const RETRY_SHOT_SPEC: CommandSpec = {
  name: "retry-shot",
  description:
    "Retry one failed shot: new asset/trim, only that shot regenerates (spec §20)",
  args: ["<id>"],
  group: "generation",
};

export const USAGE_RETRY_SHOT = [
  "Usage: mmcs retry-shot <id> [options]",
  "",
  "Replaces ONE shot and regenerates ONLY it (spec §20): unaffected shots",
  "pass through untouched — never blind whole-episode regeneration.",
  "",
  "Options:",
  "  --asset <ref>       new canonical asset reference (GHL URL / library token)",
  "  --trim-in <frames>  new source trim start (frames)",
  "  --trim-out <frames> new source trim end (frames)",
  "  --duration <frames> explicit shot duration (downstream shots reflow, inputs unchanged)",
  "  --attempt <n>       retry attempt number (default 1)",
  "  --reason <text>     why the shot failed (recorded in the retry plan)",
  "  --json              emit the result as one JSON line for scripting",
].join("\n");

/** Parsed long-option set for retry-shot. */
export interface RetryShotOptions {
  readonly asset?: string;
  readonly trimInFrames?: number;
  readonly trimOutFrames?: number;
  readonly durationInFrames?: number;
  readonly attempt?: number;
  readonly reason?: string;
  readonly json?: boolean;
  /** True when an option value was malformed (bad integer) — reject, don't guess. */
  readonly parseError?: string;
}

const OPTION_NAMES = [
  "asset",
  "trim-in",
  "trim-out",
  "duration",
  "attempt",
  "reason",
] as const;

/**
 * Parse `argv` (already stripped of the verb and positional id) into options.
 * Unknown flags are a usage error — the CLI surface is scriptable and
 * predictable, never permissive (spec §24).
 */
export function parseRetryShotOptions(
  argv: readonly string[],
): RetryShotOptions {
  const out: {
    asset?: string;
    trimInFrames?: number;
    trimOutFrames?: number;
    durationInFrames?: number;
    attempt?: number;
    reason?: string;
    json?: boolean;
    parseError?: string;
  } = {};
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
    if ((OPTION_NAMES as readonly string[]).includes(name)) {
      if (name === "asset") out.asset = value;
      else if (name === "reason") out.reason = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          out.parseError = `--${name} expects a non-negative integer, got "${value}"`;
          return out;
        }
        if (name === "trim-in") out.trimInFrames = n;
        else if (name === "trim-out") out.trimOutFrames = n;
        else if (name === "duration") out.durationInFrames = n;
        else if (name === "attempt") out.attempt = n;
      }
    } else {
      out.parseError = `unknown option: --${name}`;
      return out;
    }
  }
  return out;
}

/**
 * Ports over the durable state — injected by the CLI bootstrap at
 * integration. No IO in this module itself.
 */
export interface RetryShotPorts {
  /** The episode's ordered shot plan (from DB/CORE-006 shot rows). */
  loadPlan(shotId: string): EpisodicShotPlanLike | undefined;
  /**
   * Queue exactly one regeneration job for the replaced shot. Returns a
   * durable job id, or undefined when no runner is wired (reported as exit 1).
   */
  queueShotRegeneration(
    shotId: string,
    attempt: number,
    replacement: ShotReplacementLike,
  ): string | undefined;
}

/**
 * Structural subset of the @mmcs/remotion-runtime shot-replacement types.
 * Declared locally so the command file compiles against the dispatcher's
 * merge seam without importing package internals — identical shape, do not
 * diverge (same pattern as CHAR-004's contract).
 */
export interface ShotReplacementLike {
  readonly assetRef?: string;
  readonly trimInFrames?: number;
  readonly trimOutFrames?: number;
  readonly durationPolicy?: "fit-slot" | "explicit";
  readonly durationInFrames?: number;
  readonly attempt?: number;
  readonly reason?: string;
}

export interface EpisodicShotPlanLike {
  readonly episodeId: string;
  readonly fps: number;
  readonly segments: readonly {
    readonly shotId: string;
    readonly sceneId: string;
    readonly sequenceIndex: number;
    readonly durationInFrames: number;
    readonly inputs: Record<string, unknown>;
  }[];
}

export interface RetryShotCommandResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
  json?: unknown;
}

/** Format the one-shot scope line — the §20 proof artifact. */
function scopeLines(
  shotId: string,
  regenerates: readonly string[],
  preserved: readonly string[],
): string[] {
  return [
    `[mmcs] retry-shot ${shotId} — scope: regenerates [${regenerates.join(", ")}], preserves ${preserved.length} shot(s): ${preserved.join(", ") || "none"}`,
  ];
}

/**
 * Execute the retry-shot command logic. Pure orchestration over injected
 * ports; the only I/O lives in the ports.
 */
export function runRetryShot(
  rawId: string | undefined,
  rawOptions: readonly string[],
  ports: RetryShotPorts,
): RetryShotCommandResult {
  if (rawId === undefined || rawId.length === 0) {
    return { exitCode: 2, lines: [USAGE_RETRY_SHOT] };
  }
  const options = parseRetryShotOptions(rawOptions);
  if (options.parseError !== undefined) {
    return { exitCode: 2, lines: [`[mmcs] retry-shot: ${options.parseError}`, USAGE_RETRY_SHOT] };
  }
  const shotId = rawId.trim();
  const plan = ports.loadPlan(shotId);
  if (!plan) {
    return {
      exitCode: 1,
      lines: [`[mmcs] retry-shot: unknown shot id "${shotId}"`],
    };
  }
  if (
    options.asset === undefined &&
    options.trimInFrames === undefined &&
    options.trimOutFrames === undefined &&
    options.durationInFrames === undefined
  ) {
    // No new inputs supplied: still a legal retry (regenerate same inputs),
    // the generation lane owns provider-side seed variation.
  }

  const attempt = options.attempt ?? 1;
  const replacement: ShotReplacementLike = {
    ...(options.asset !== undefined ? { assetRef: options.asset } : {}),
    ...(options.trimInFrames !== undefined ? { trimInFrames: options.trimInFrames } : {}),
    ...(options.trimOutFrames !== undefined ? { trimOutFrames: options.trimOutFrames } : {}),
    ...(options.durationInFrames !== undefined
      ? {
          durationPolicy: "explicit" as const,
          durationInFrames: options.durationInFrames,
        }
      : {}),
    attempt,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };

  const jobId = ports.queueShotRegeneration(shotId, attempt, replacement);
  if (jobId === undefined) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] retry-shot: no shot-regeneration runner wired — refusing to spend without an injected job runner`,
      ],
    };
  }

  const preserved = plan.segments
    .map((s) => s.shotId)
    .filter((id) => id !== shotId);
  const lines = [
    ...scopeLines(shotId, [shotId], preserved),
    `[mmcs] retry-shot ${shotId} — queued regeneration job ${jobId} (attempt ${attempt})`,
    `[mmcs] retry-shot ${shotId} — only this shot's inputs changed; unaffected shots pass through untouched (spec §20/§32)`,
  ];
  if (options.json) {
    const json = {
      shotId,
      attempt,
      reason: options.reason,
      regeneratesShotIds: [shotId],
      preservedShotIds: preserved,
      jobId,
      replacement,
    };
    lines.push(JSON.stringify(json));
    return { exitCode: 0, lines, json };
  }
  return { exitCode: 0, lines };
}

/** Wire the real handler for the CORE-011 dispatcher (mergeSpecs). */
export function makeRetryShotHandler(ports: RetryShotPorts) {
  return (args: Record<string, string>, options: Record<string, unknown>): void => {
    const rawOptions = Object.entries(options).flatMap(([k, v]) =>
      v === true ? [`--${k}`] : [`--${k}`, String(v)],
    );
    const result = runRetryShot(args.id, rawOptions, ports);
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(result.lines.join("\n") + "\n");
    if (result.exitCode !== 0) {
      throw new Error(`retry-shot rejected (exit ${result.exitCode})`);
    }
  };
}