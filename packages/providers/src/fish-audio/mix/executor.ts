/**
 * Mix executor (FISH-009) — runs a compiled mix and verifies the output.
 *
 * Pure producer: compiles the plan with `compileMixGraph`, then runs ffmpeg
 * with a child process (never a shell — argv is passed verbatim), then probes
 * the output with ffprobe and returns a `MixResult`. Story/dialogue text never
 * reaches the invocation (the compiler never interpolates text — only
 * validated numbers and caller-supplied paths), so this layer has nothing
 * more to sanitize.
 *
 * Determinism note: execution is side-effectful by nature, but the *argv*
 * given to ffmpeg is byte-for-byte deterministic for a given plan (see
 * graph.ts), which is what makes re-runs and audits possible.
 */
import { spawn } from "node:child_process";
import type { CompiledMix, MixPlan, MixResult } from "./types.js";
import { compileMixGraph } from "./graph.js";

/** Raised when ffmpeg or ffprobe exits non-zero (or cannot be spawned). */
export class MixExecError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(command: string, exitCode: number | null, stderrTail: string, message?: string) {
    super(message ?? `MixExecError: "${command}" exited with code ${String(exitCode)}`);
    this.name = "MixExecError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** Options for {@link runMix} / {@link runFfmpeg}. */
export interface MixRunOptions {
  /** ffmpeg binary path (default "ffmpeg", resolved on PATH). */
  ffmpegBin?: string;
  /** ffprobe binary path (default "ffprobe", resolved on PATH). */
  ffprobeBin?: string;
  /** Abort/overshoot guard: kill ffmpeg after this many ms. Default 120000. */
  timeoutMs?: number;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new MixExecError(
          bin,
          null,
          stderr,
          `MixExecError: "${bin}" timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new MixExecError(
          bin,
          null,
          stderr,
          `MixExecError: failed to spawn "${bin}": ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().slice(-2000);
        reject(new MixExecError(bin, code, tail));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** Run the compiled argv and return raw ffprobe text (empty if probe failed). */
async function probeAudio(
  ffprobeBin: string,
  file: string,
  timeoutMs: number,
): Promise<{ ok: boolean; durationSec: number; streams: MixResult["streams"] }> {
  try {
    const res = await runProcess(ffprobeBin, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name",
      "-of",
      "json",
      file,
    ], timeoutMs);
    const json = JSON.parse(res.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string }>;
    };
    const durationSec = Number.parseFloat(json.format?.duration ?? "");
    const streams = (json.streams ?? [])
      .filter((s) => s.codec_type === "audio")
      .map((s) => ({ codecType: s.codec_type ?? "audio", codecName: s.codec_name ?? "unknown" }));
    if (!Number.isFinite(durationSec) || streams.length === 0) return { ok: false, durationSec: 0, streams };
    return { ok: true, durationSec, streams };
  } catch {
    return { ok: false, durationSec: 0, streams: [] };
  }
}

/**
 * Compile + run a mix plan end-to-end. Returns the probed result.
 * Throws {@link MixPlanError} for invalid plans and {@link MixExecError} when
 * ffmpeg/ffprobe fail.
 */
export async function runMix(plan: MixPlan, options: MixRunOptions = {}): Promise<MixResult> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? 120_000;

  const compiled = compileMixGraph(plan, ffmpegBin);
  // compiled.argv[0] IS the ffmpeg binary (compileMixGraph pins ffmpegBin at
  // index 0); runProcess takes args only, so drop it here.
  await runProcess(ffmpegBin, compiled.argv.slice(1), timeoutMs);
  return verifyOutput(compiled.output.path, ffprobeBin, timeoutMs);
}

/**
 * Run a pre-compiled mix (no re-compile, no re-validation). Exposed for
 * callers that already hold a {@link CompiledMix}, e.g. replaying an audited
 * plan whose argv was persisted.
 */
export async function runCompiledMix(
  compiled: CompiledMix,
  options: MixRunOptions = {},
): Promise<MixResult> {
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? 120_000;
  await runProcess(compiled.argv[0] ?? "ffmpeg", compiled.argv, timeoutMs);
  return verifyOutput(compiled.output.path, ffprobeBin, timeoutMs);
}

/** Run an explicit ffmpeg argv and return ffprobe verification of `outputPath`. */
export async function runFfmpeg(
  argv: string[],
  outputPath: string,
  options: MixRunOptions = {},
): Promise<MixResult> {
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? 120_000;
  await runProcess(argv[0] ?? "ffmpeg", argv, timeoutMs);
  return verifyOutput(outputPath, ffprobeBin, timeoutMs);
}

async function verifyOutput(
  outputPath: string,
  ffprobeBin: string,
  timeoutMs: number,
): Promise<MixResult> {
  const probe = await probeAudio(ffprobeBin, outputPath, timeoutMs);
  if (!probe.ok) {
    throw new MixExecError(
      ffprobeBin,
      null,
      `output "${outputPath}" failed ffprobe audio check`,
    );
  }
  return { output: outputPath, durationSec: probe.durationSec, streams: probe.streams };
}
