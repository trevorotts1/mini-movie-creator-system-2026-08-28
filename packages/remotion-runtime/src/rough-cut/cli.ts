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

/** Parsed flags for `mmcs rough-cut`. */
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
  return { episodeId: positionals[0], dryRun, json };
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
  return [
    `[mmcs] rough-cut: ${result.compositionId} assembled — ${result.resolution.width}x${result.resolution.height}@${result.fps}, ${result.totalFrames} frames (${result.durationSeconds.toFixed(2)}s)`,
    `[mmcs] rough-cut: ${result.shotCount} shot(s), ${result.dialogueCount} dialogue line(s), temp music: ${result.hasTempMusic ? "yes" : "no"}`,
    `[mmcs] rough-cut: wrote ${result.fileName} (ffprobe-valid)`,
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
    return {
      exitCode: 1,
      lines: [`[mmcs] rough-cut: unknown episode '${opts.episodeId}'`],
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
