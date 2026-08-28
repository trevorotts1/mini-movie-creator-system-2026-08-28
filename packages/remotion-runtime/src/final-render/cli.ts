// `mmcs final` command wiring (spec §24) — VID-014.
//
// Owns only this directory (packages/remotion-runtime/src/final-render/).
// The CORE-011 dispatcher merges the exported CommandSpec over its stub at
// integration; the spec/handler shapes mirror apps/cli/src/dispatch/*
// (CommandSpec + Handler) so the merge is structural — the same pattern
// CAP-009 and CHAR-004 used.
//
// Exit contract (documented, dispatcher owns termination — never
// process.exit):
//   0 — final render completed and archived (or planned, with --dry-run)
//   1 — blocked (rough-cut gate not approved) or render/validation failure;
//       the stable FinalRenderError.code is printed for scripting.
// Bare `mmcs final` (no episode) prints usage and exits 0 — discoverability,
// matching the choose-character precedent.

import { FinalRenderError, runFinalRender, type FinalRenderPorts } from "./pipeline.js";
import type { FinalRenderSpec } from "./contract.js";

/** The dispatcher CommandSpec shape (structural twin of apps/cli's). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const FINAL_SPEC: CommandSpec = {
  name: "final",
  description: "Render the final episode into 08 Final (gate 5, spec §3.5/§21)",
  group: "generation",
};

export const USAGE_FINAL = [
  "Usage: mmcs final <episodeId> [--dry-run] [--native] [--json]",
  "",
  "Renders the APPROVED rough cut to the final episode file (spec §21):",
  "  1. verifies the rough-cut approval gate (gate 5) is APPROVED",
  "  2. renders at the series/episode master resolution (or --native for scale=1)",
  "  3. validates the output with ffprobe (VID-015 contract) before anything else",
  "  4. writes honest quality metadata (720p upscales are flagged, never 'native 1080p')",
  "  5. archives the final into `08 Final/` and prints the production report",
  "",
  "Exit 0 on success, 1 when the gate is not approved or a step fails.",
].join("\n");

/** Parsed flags for `mmcs final`. */
export interface FinalCliOptions {
  episodeId?: string;
  dryRun: boolean;
  native: boolean;
  json: boolean;
}

/** Parse raw CLI argv (already past the `final` verb). */
export function parseFinalArgs(argv: readonly string[]): FinalCliOptions {
  const positionals: string[] = [];
  let dryRun = false;
  let native = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--native") native = true;
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("--")) positionals.push(arg);
  }
  return { episodeId: positionals[0], dryRun, native, json };
}

/** Result the handler prints; exposed for tests. */
export interface FinalCliResult {
  exitCode: 0 | 1;
  lines: string[];
}

/**
 * Execute the `final` command. `specFactory` resolves the episode's
 * FinalRenderSpec from durable state (DB/repos at integration); `ports`
 * carries the gate/render/validate/archive adapters.
 */
export async function executeFinal(
  argv: readonly string[],
  specFactory: (episodeId: string) => FinalRenderSpec | undefined,
  ports: FinalRenderPorts,
): Promise<FinalCliResult> {
  const opts = parseFinalArgs(argv);
  if (!opts.episodeId) {
    return { exitCode: 0, lines: [USAGE_FINAL] };
  }
  const spec = specFactory(opts.episodeId);
  if (!spec) {
    return {
      exitCode: 1,
      lines: [`[mmcs] final: unknown episode '${opts.episodeId}'`],
    };
  }
  if (opts.native) spec.mode = "native";
  try {
    if (opts.dryRun) {
      const { planFinalRender } = await import("./pipeline.js");
      const plan = planFinalRender(spec, ports.approvals);
      return {
        exitCode: plan.renderable ? 0 : 1,
        lines: [
          plan.renderable
            ? `[mmcs] final: READY ${plan.outputFileName} → ${plan.outputFolder.join("/")}`
            : `[mmcs] final: BLOCKED — ${plan.blockedReason}`,
        ],
      };
    }
    const report = await runFinalRender(spec, ports);
    const lines = opts.json
      ? [JSON.stringify(report)]
      : formatReportLines(report);
    return { exitCode: 0, lines };
  } catch (err) {
    if (err instanceof FinalRenderError) {
      return { exitCode: 1, lines: [`[mmcs] final: ${err.code} — ${err.message}`] };
    }
    return {
      exitCode: 1,
      lines: [`[mmcs] final: unexpected failure: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** Human-readable production report lines (spec §21 fields). */
export function formatReportLines(report: {
  episodeCode: string;
  aspectRatio: string;
  resolution: { width: number; height: number };
  durationSeconds: number;
  qualityTier: string;
  upscaledShotCount: number;
  shotCount: number;
  archived: boolean;
  durableFinalUrl?: string;
  ghlFileId?: string;
}): string[] {
  const lines = [
    `[mmcs] final: ${report.episodeCode} rendered — ${report.aspectRatio} ${report.resolution.width}x${report.resolution.height}, ${report.durationSeconds}s`,
    `[mmcs] quality: ${report.qualityTier} (${report.upscaledShotCount}/${report.shotCount} shot(s) upscaled — upscaled sources never labeled native)`,
  ];
  if (report.archived) {
    lines.push(
      `[mmcs] archived: ${report.durableFinalUrl ?? "(url pending)"}${report.ghlFileId ? ` (fileId ${report.ghlFileId})` : ""}`,
    );
  } else {
    lines.push(`[mmcs] archive: skipped (no archive port configured)`);
  }
  return lines;
}