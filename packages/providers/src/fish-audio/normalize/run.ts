/**
 * The normalization runner (FISH-008).
 *
 * Two-pass ffmpeg loudnorm:
 *   pass 1 (measure)  — `-af loudnorm(I=...,TP=...,LRA=...,print_format=json)`
 *                       against a null sink; the analysis JSON lands on
 *                       stderr.
 *   pass 2 (apply)    — `-af loudnorm(...,measured_I=...,linear=true)` +
 *                       fixed output encoding. One STATIC gain, no dynamic
 *                       pumping.
 *
 * ACCEPTANCE: probe-before/after — the input is ffprobed before anything
 * runs, the output is ffprobed after, and both fact sets travel on the
 * result. Target LUFS configurable via options; args deterministic via
 * `buildNormalizeArgs`.
 */

/// <reference types="node" />
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildNormalizeArgs,
  parseLoudnormJson,
  resolveNormalizeOptions,
  type LoudnessMeasurements,
  type NormalizeOptions,
  type ResolvedNormalizeOptions,
} from "./config.js";
import { NormalizeError } from "./errors.js";
import { probeAudio, type AudioFacts } from "./probe.js";

const execFileAsync = promisify(execFile);

/** Default ffmpeg binary — resolved from PATH. */
export const DEFAULT_FFMPEG_PATH = "ffmpeg";

/** Upper bound on any single ffmpeg run (dialogue assets are short). */
export const NORMALIZE_TIMEOUT_MS = 60_000;

/**
 * ffmpeg's loudnorm needs at least ~3 seconds of audio to produce a stable
 * measurement (EBU R128 gating window). Shorter inputs are rejected
 * up-front with a clear message instead of a confusing -inf.
 */
export const MIN_MEASURE_SECONDS = 3;

/** Result of normalizing one audio file. */
export interface NormalizeResult {
  /** Absolute path of the normalized output. */
  outputPath: string;
  /** Options actually used (fully resolved — no implicit defaults left). */
  options: ResolvedNormalizeOptions;
  /** Input loudness measured by pass 1. */
  measured: LoudnessMeasurements;
  /** ffprobe facts of the input, captured BEFORE normalization. */
  before: AudioFacts;
  /** ffprobe facts of the output, captured AFTER normalization. */
  after: AudioFacts;
}

/** Guards a user-supplied path: string, non-empty, no NUL (exec safety). */
function assertPath(value: unknown, label: "input" | "output"): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new NormalizeError(
      "input",
      `${label}Path must be a non-empty string without NUL bytes (got ${typeof value === "string" ? "empty/NUL" : typeof value})`,
    );
  }
  return value;
}

/**
 * Normalize one audio file to the configured loudness target.
 *
 * Never modifies the input — the normalized result is written to
 * `outputPath` (in-place callers pass a temp path and swap themselves).
 * Story/asset file NAMES are untrusted data (spec §21/§47): they are passed
 * to ffmpeg strictly as argument values via `execFile` (no shell), never
 * interpolated into a command string, and never evaluated.
 */
export async function normalizeAudio(
  inputPath: string,
  outputPath: string,
  options: NormalizeOptions = {},
  ffmpegPath: string = DEFAULT_FFMPEG_PATH,
): Promise<NormalizeResult> {
  const input = assertPath(inputPath, "input");
  const output = assertPath(outputPath, "output");
  const resolved = resolveNormalizeOptions(options);

  // PROBE-BEFORE: fail before spawning ffmpeg when the input is not a
  // decodable audio file.
  const before = await probeAudio(input);

  if (before.durationSeconds < MIN_MEASURE_SECONDS) {
    throw new NormalizeError(
      "input",
      `input too short to measure (${before.durationSeconds.toFixed(2)}s < ${String(MIN_MEASURE_SECONDS)}s minimum for EBU R128 gating)`,
    );
  }

  // PASS 1 — measure.
  const { measureArgs, applyArgs } = buildNormalizeArgs(resolved, PLACEHOLDER, input, output);
  const measureStderr = await runFfmpeg(ffmpegPath, measureArgs, input, "measure");
  const measured = parseLoudnormJson(measureStderr);

  // PASS 2 — apply (static gain from the measured values).
  const finalApplyArgs = applyArgsWithMeasurements(resolved, measured, input, output);
  await runFfmpeg(ffmpegPath, finalApplyArgs, input, "apply");

  // VERIFY + PROBE-AFTER.
  const outStat = await stat(output).catch(() => {
    throw new NormalizeError("verify", `normalize produced no output file: ${output}`);
  });
  if (outStat.size === 0) {
    throw new NormalizeError("verify", `normalize produced an empty output file: ${output}`);
  }
  const after = await probeAudio(output);

  return {
    outputPath: path.resolve(output),
    options: resolved,
    measured,
    before,
    after,
  };
}

/**
 * Apply-pass args with the REAL measured values. `buildNormalizeArgs`
 * requires measurements; keep one indirection so the runner stays explicit
 * about when measurement happens.
 */
function applyArgsWithMeasurements(
  resolved: ResolvedNormalizeOptions,
  measured: LoudnessMeasurements,
  input: string,
  output: string,
): string[] {
  return buildNormalizeArgs(resolved, measured, input, output).applyArgs;
}

/** Placeholder satisfying `buildNormalizeArgs`'s signature for the measure pass. */
const PLACEHOLDER: LoudnessMeasurements = {
  inputI: 0,
  inputTp: 0,
  inputLra: 0,
  inputThresh: 0,
  targetOffset: 0,
};

/** Run one ffmpeg pass; maps spawn/exit failures onto NormalizeError. */
async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  inputPath: string,
  pass: "measure" | "apply",
): Promise<string> {
  try {
    // measure pass runs at -v info (loudnorm JSON lands on stderr); apply
    // pass runs at -v error (the args already fix the verbosity).
    const { stderr } = await execFileAsync(ffmpegPath, args, {
      encoding: "utf8",
      timeout: NORMALIZE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stderr ?? "";
  } catch (error) {
    const err = error as { stderr?: unknown; killed?: boolean; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : undefined;
    const detail = stderr
      ? stderr.slice(-1000)
      : (err.message ?? "unknown ffmpeg failure");
    if (pass === "measure") {
      throw new NormalizeError(
        "measure",
        `ffmpeg loudnorm measurement failed for ${inputPath}: ${detail}`,
        stderr?.slice(-2000),
      );
    }
    throw new NormalizeError(
      "ffmpeg",
      `ffmpeg normalization encode failed for ${inputPath}: ${detail}`,
      stderr?.slice(-2000),
    );
  }
}
