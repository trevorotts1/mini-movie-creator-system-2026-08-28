// `mmcs rough-cut` command wiring (spec §24) — VID-012.
//
// Owns only this directory (packages/remotion-runtime/src/rough-cut/). The
// CORE-011 dispatcher merges the exported CommandSpec over its stub at
// integration; the spec/handler shapes mirror apps/cli/src/dispatch/*
// (CommandSpec + Handler) so the merge is structural — the same pattern
// VID-013 (`mmcs retry-shot`) and VID-014 (`mmcs final`) used.
//
// Exit contract (documented, dispatcher owns termination — never
// process.exit):
//   0 — rough cut rendered and ffprobe-valid (or planned, with --dry-run)
//   1 — plan invalid or render/validation failed; the stable
//       RoughCutError.code is printed for scripting.
// Bare `mmcs rough-cut` (no episode) prints usage and exits 0 —
// discoverability, matching the `final` precedent.

import { RoughCutError, type RoughCutErrorCode } from "./errors.js";
import { planRoughCutRender, renderRoughCut, type RoughCutRenderAdapter } from "./render.js";
import type { RoughCutPlan } from "./types.js";

/** The dispatcher CommandSpec shape (structural twin of apps/cli's). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const ROUGH_CUT_SPEC: CommandSpec = {
  name: "rough-cut",
  description: "Assemble the episode rough-cut preview MP4 (spec §21/§32)",
  group: "generation",
};

export const USAGE_ROUGH_CUT = [
  "Usage: mmcs rough-cut <episodeId> [--dry-run] [--json]",
  "",
  "Assembles the full episode rough cut (spec §21): shot plan + archived",
  "assets + dialogue + temp music → preview MP4, then validates it with",
  "ffprobe before reporting success (spec §32).",
  "",
  "Exit 0 on success, 1 when the plan is invalid or a step fails.",
].join("\n");

/** Maximum display width for untrusted ids echoed into CLI lines. */
const MAX_ID_DISPLAY = 120;

/**
 * Escape an untrusted value for a single-quoted shell snippet. Episode ids
 * come from `mmcs rough-cut <episodeId>` argv (spec §29: never executable),
 * so any id echoed into advice text must be shell-quote-safe.
 */
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Truncate untrusted text for CLI display. Text arriving through argv or a
 * plan is data, never control: terminal escape sequences (ANSI/OSC) and
 * unbounded lengths must not survive into printed lines. Long values are
 * shortened and marked; non-printable characters are stripped.
 */
export function sanitizeCliText(value: string, max = MAX_ID_DISPLAY): string {
  // Strip C0/C1 control characters (including ESC, and the OSC/CSI
  // lead-ins). Escapes are explicit here: raw control bytes in source
  // are invisible and fragile across editors.
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return clean.length > max ? clean.slice(0, max) + "\u2026" : clean;
}
export interface RoughCutCliOptions {
  episodeId?: string;
  dryRun: boolean;
  json: boolean;
}

/** Parse raw CLI argv (already past the `rough-cut` verb). */
export function parseRoughCutArgs(argv: readonly string[]): RoughCutCliOptions {
  const positionals: string[] = [];
  let dryRun = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("--")) positionals.push(arg);
  }
  return {
    episodeId:
      positionals[0] === undefined ? undefined : sanitizeCliText(positionals[0]),
    dryRun,
    json,
  };
}

/** Result the handler prints; exposed for tests. */
export interface RoughCutCliResult {
  exitCode: 0 | 1;
  lines: string[];
}

/** Human-readable result lines. */
export function formatRoughCutLines(result: {
  fileName: string;
  compositionId: string;
  resolution: { width: number; height: number };
  fps: number;
  totalFrames: number;
  durationSeconds: number;
  shotCount: number;
  dialogueCount: number;
  hasTempMusic: boolean;
}): string[] {
  // compositionId/fileName derive from the validated episodeCode; sanitize
  // again here so no control sequence or oversized id ever reaches a terminal.
  const compositionId = sanitizeCliText(result.compositionId);
  const fileName = sanitizeCliText(result.fileName);
  return [
    `[mmcs] rough-cut: ${compositionId} assembled — ${result.resolution.width}x${result.resolution.height}@${result.fps}, ${result.totalFrames} frames (${result.durationSeconds.toFixed(2)}s)`,
    `[mmcs] rough-cut: ${result.shotCount} shot(s), ${result.dialogueCount} dialogue line(s), temp music: ${result.hasTempMusic ? "yes" : "no"}`,
    `[mmcs] rough-cut: wrote ${fileName} (ffprobe-valid)`,
  ];
}

/**
 * Execute the `rough-cut` command. `planFactory` resolves the episode's
 * RoughCutPlan from durable state (DB/repos at integration); `render` is the
 * render adapter (fixture now, Remotion at integration).
 */
export async function executeRoughCut(
  argv: readonly string[],
  planFactory: (episodeId: string) => RoughCutPlan | undefined,
  render: RoughCutRenderAdapter,
  options: { outputDir?: string; validate?: (output: string) => Promise<{ ok: boolean; error?: string }> } = {},
): Promise<RoughCutCliResult> {
  const opts = parseRoughCutArgs(argv);
  if (!opts.episodeId) {
    return { exitCode: 0, lines: [USAGE_ROUGH_CUT] };
  }
  const plan = planFactory(opts.episodeId);
  if (!plan) {
    // opts.episodeId is already sanitized by parseRoughCutArgs; quote it so
    // the advice line is shell-safe for copy-paste.
    return {
      exitCode: 1,
      lines: [
        `[mmcs] rough-cut: unknown episode ${quoteShell(opts.episodeId)}`,
      ],
    };
  }
  try {
    if (opts.dryRun) {
      const assembled = planRoughCutRender(plan, options);
      return {
        exitCode: 0,
        lines: [
          `[mmcs] rough-cut: READY ${assembled.fileName} — ${assembled.timeline.totalFrames} frames @ ${assembled.timeline.fps}fps ${assembled.timeline.resolution.width}x${assembled.timeline.resolution.height}`,
        ],
      };
    }
    const result = await renderRoughCut(plan, { render, validate: options.validate }, options);
    const lines = opts.json
      ? [JSON.stringify(result)]
      : formatRoughCutLines(result);
    return { exitCode: 0, lines };
  } catch (err) {
    if (err instanceof RoughCutError) {
      return { exitCode: 1, lines: [`[mmcs] rough-cut: ${err.code} — ${err.message}`] };
    }
    return {
      exitCode: 1,
      lines: [`[mmcs] rough-cut: unexpected failure: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

export type { RoughCutErrorCode };
