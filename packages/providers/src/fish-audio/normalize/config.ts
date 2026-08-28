/**
 * Normalization contract configuration (FISH-008).
 *
 * Target loudness is CONFIG-DRIVEN (spec §16: model selection and pricing
 * are config-driven). No provider free-tier or spec text is hard-coded here
 * — every caller passes explicit targets or takes the documented defaults
 * below.
 *
 * ARG DETERMINISM (acceptance): the exact ffmpeg argument array is a pure
 * function of the resolved options (+ the measured input loudness for the
 * apply pass). Same inputs → byte-identical args, every run, every machine.
 * Timestamps, locale, environment, and file names never enter the
 * deterministic prefix — paths are appended LAST so the prefix never varies
 * with file names.
 */

import { NormalizeError } from "./errors.js";

/**
 * Output loudness target in LUFS (LKFS, ITU-R BS.1770). Default -16 LUFS —
 * the common podcast/mobile-dialogue target; `-14` (streaming) and `-23`
 * (EBU broadcast) are the other industry-standard targets. Must be finite.
 */
export const NORMALIZE_DEFAULT_TARGET_LUFS = -16;

/**
 * True-peak ceiling in dBTP. Default -1.5 dBTP — headroom for lossy codecs
 * (AAC inter-sample peaks). Must be < 0.
 */
export const NORMALIZE_DEFAULT_TRUE_PEAK_DBTP = -1.5;

/**
 * Loudness range target (LRA) in LU. Default 11 LU (EBU R128 short-form
 * dialogue). `null` = omit the `LRA=` option entirely (no LRA constraint).
 */
export const NORMALIZE_DEFAULT_LRA_LU = 11;

/**
 * Loudness verification tolerance in LU. loudnorm's linear mode lands the
 * output within ~±0.5 LU of the target on well-behaved input; 1.0 LU gives
 * margin for the EBU gating window without accepting a broken run.
 */
export const NORMALIZE_VERIFY_TOLERANCE_LU = 1.0;

/**
 * Two-pass loudnorm is the ONLY supported mode. One-pass loudnorm applies a
 * dynamic (time-varying) gain that pumps dialogue; two-pass measures the
 * whole input first, then applies ONE static gain — deterministic and safe
 * for spoken dialogue.
 */
export const NORMALIZE_PASSES = 2;

export interface NormalizeOptions {
  /**
   * Integrated loudness target, LUFS. Configurable (acceptance). Default
   * -16 LUFS.
   */
  targetLufs?: number;
  /** True-peak ceiling, dBTP. Default -1.5 dBTP. Must be < 0. */
  truePeakDbtp?: number;
  /** Loudness range target, LU. Default 11; `null` disables the constraint. */
  lraLu?: number | null;
  /**
   * Sample rate of the normalized output, Hz. Default 48000 — the video
   * master rate the Remotion/FFmpeg pipeline (spec §31) muxes at.
   */
  sampleRateHz?: number;
  /** Output channel count. Default 2 (stereo). 1 = mono. */
  channels?: 1 | 2;
  /**
   * Output container. Default "wav" (PCM 16-bit) — the dialogue-asset
   * working format the mix pipeline (FISH-009) consumes. "m4a" also
   * supported for archival-sized outputs.
   */
  format?: "wav" | "m4a";
}

/** Fully-defaulted, validated options. */
export interface ResolvedNormalizeOptions {
  targetLufs: number;
  truePeakDbtp: number;
  lraLu: number | null;
  sampleRateHz: number;
  channels: 1 | 2;
  format: "wav" | "m4a";
}

/** Hard bounds — keeps ffmpeg args inside ffmpeg's validated loudnorm domain. */
export const NORMALIZE_TARGET_LUFS_MIN = -70;
export const NORMALIZE_TARGET_LUFS_MAX = -5;
export const NORMALIZE_TRUE_PEAK_MIN = -12;
export const NORMALIZE_TRUE_PEAK_MAX = -0.1;
export const NORMALIZE_LRA_MIN = 1;
export const NORMALIZE_LRA_MAX = 50;
export const NORMALIZE_SAMPLE_RATE_MIN = 8_000;
export const NORMALIZE_SAMPLE_RATE_MAX = 192_000;

/**
 * Validate + default normalization options. Throws `NormalizeError`
 * (kind "config") on any out-of-range or non-finite value.
 */
export function resolveNormalizeOptions(
  options: NormalizeOptions = {},
): ResolvedNormalizeOptions {
  const targetLufs = options.targetLufs ?? NORMALIZE_DEFAULT_TARGET_LUFS;
  if (
    !Number.isFinite(targetLufs) ||
    targetLufs < NORMALIZE_TARGET_LUFS_MIN ||
    targetLufs > NORMALIZE_TARGET_LUFS_MAX
  ) {
    throw new NormalizeError(
      "config",
      `targetLufs must be a finite number between ${String(NORMALIZE_TARGET_LUFS_MIN)} and ${String(NORMALIZE_TARGET_LUFS_MAX)} (got ${String(targetLufs)})`,
    );
  }

  const truePeakDbtp = options.truePeakDbtp ?? NORMALIZE_DEFAULT_TRUE_PEAK_DBTP;
  if (
    !Number.isFinite(truePeakDbtp) ||
    truePeakDbtp < NORMALIZE_TRUE_PEAK_MIN ||
    truePeakDbtp > NORMALIZE_TRUE_PEAK_MAX
  ) {
    throw new NormalizeError(
      "config",
      `truePeakDbtp must be a finite number between ${String(NORMALIZE_TRUE_PEAK_MIN)} and ${String(NORMALIZE_TRUE_PEAK_MAX)} (got ${String(truePeakDbtp)})`,
    );
  }

  let lraLu: number | null;
  if (options.lraLu === undefined) {
    lraLu = NORMALIZE_DEFAULT_LRA_LU;
  } else if (options.lraLu === null) {
    lraLu = null;
  } else if (
    !Number.isFinite(options.lraLu) ||
    options.lraLu < NORMALIZE_LRA_MIN ||
    options.lraLu > NORMALIZE_LRA_MAX
  ) {
    throw new NormalizeError(
      "config",
      `lraLu must be null or a finite number between ${String(NORMALIZE_LRA_MIN)} and ${String(NORMALIZE_LRA_MAX)} (got ${String(options.lraLu)})`,
    );
  } else {
    lraLu = options.lraLu;
  }

  const sampleRateHz = options.sampleRateHz ?? 48_000;
  if (
    !Number.isInteger(sampleRateHz) ||
    sampleRateHz < NORMALIZE_SAMPLE_RATE_MIN ||
    sampleRateHz > NORMALIZE_SAMPLE_RATE_MAX
  ) {
    throw new NormalizeError(
      "config",
      `sampleRateHz must be an integer between ${String(NORMALIZE_SAMPLE_RATE_MIN)} and ${String(NORMALIZE_SAMPLE_RATE_MAX)} (got ${String(sampleRateHz)})`,
    );
  }

  const channels = options.channels ?? 2;
  if (channels !== 1 && channels !== 2) {
    throw new NormalizeError("config", `channels must be 1 or 2 (got ${String(channels)})`);
  }

  const format = options.format ?? "wav";
  if (format !== "wav" && format !== "m4a") {
    throw new NormalizeError("config", `format must be "wav" or "m4a" (got ${String(format)})`);
  }

  return { targetLufs, truePeakDbtp, lraLu, sampleRateHz, channels, format };
}

/**
 * One loudness measurement as loudnorm's `print_format=json` reports it.
 * All fields in dB/LU — ffmpeg prints them as strings. `targetOffset` is
 * loudnorm's own `target_offset` (the limiter-compensation gain) and is the
 * ONLY value that may be fed back as the apply pass's `offset=` option —
 * feeding a hand-computed (target - measured) offset double-applies gain
 * and overshoots the target (found empirically 2026-08-28, ffmpeg 8.1.1).
 */
export interface LoudnessMeasurements {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

/**
 * The loudnorm filter string for ONE pass. Deterministic: fixed decimal
 * formatting (never locale-dependent `toString`), options in a fixed order.
 * Without `measured` this is the MEASURE pass (analysis only — no gain is
 * applied to the signal); with `measured` this is the APPLY pass pinning
 * the measured facts so ffmpeg applies ONE static gain (`linear=true`).
 */
export function loudnormFilter(
  options: ResolvedNormalizeOptions,
  measured?: LoudnessMeasurements,
): string {
  const parts = [
    `I=${options.targetLufs.toFixed(1)}`,
    `TP=${options.truePeakDbtp.toFixed(1)}`,
  ];
  if (options.lraLu !== null) parts.push(`LRA=${options.lraLu.toFixed(1)}`);
  parts.push("print_format=json");
  if (measured) {
    parts.push(
      `measured_I=${measured.inputI.toFixed(1)}`,
      `measured_TP=${measured.inputTp.toFixed(1)}`,
      `measured_LRA=${measured.inputLra.toFixed(1)}`,
      `measured_thresh=${measured.inputThresh.toFixed(1)}`,
      // loudnorm's own limiter-compensation value from the measure pass.
      `offset=${measured.targetOffset.toFixed(2)}`,
      "linear=true",
    );
  }
  return `loudnorm=${parts.join(":")}`;
}

/** Output codec args per format. Deterministic — fixed encoder, fixed bits. */
function outputCodecArgs(format: ResolvedNormalizeOptions["format"]): string[] {
  switch (format) {
    case "wav":
      // PCM 16-bit little-endian — the dialogue working format (FISH-009).
      return ["-c:a", "pcm_s16le"];
    case "m4a":
      // Native AAC encoder at a fixed bitrate — no external encoder needed.
      return ["-c:a", "aac", "-b:a", "192k"];
  }
}

/** Null sink for the analysis pass (ffmpeg must write SOMETHING). */
function nullSink(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Full deterministic ffmpeg argument arrays for both passes. The argument
 * values are a pure function of `(options, measurements)`; paths are always
 * the final argument. Unit tests assert exact arrays without spawning
 * ffmpeg.
 */
export interface NormalizeArgSets {
  /** Pass 1: measure (`-af loudnorm(analysis)`, JSON on stderr). */
  measureArgs: string[];
  /** Pass 2: apply (`-af loudnorm(measured, linear=true)` + encode). */
  applyArgs: string[];
}

export function buildNormalizeArgs(
  options: ResolvedNormalizeOptions,
  measurements: LoudnessMeasurements,
  inputPath: string,
  outputPath: string,
): NormalizeArgSets {
  const sampleRate = String(options.sampleRateHz);
  const channelLayout = options.channels === 1 ? "mono" : "stereo";

  return {
    measureArgs: [
      "-v", "info",
      "-nostdin",
      "-i", inputPath,
      "-map", "0:a:0",
      "-af", loudnormFilter(options),
      "-f", "null",
      nullSink(),
    ],
    applyArgs: [
      "-v", "error",
      "-nostdin",
      "-i", inputPath,
      "-map", "0:a:0",
      "-af", loudnormFilter(options, measurements),
      "-ar", sampleRate,
      "-ac", String(options.channels),
      "-channel_layout", channelLayout,
      ...outputCodecArgs(options.format),
      // Strip creation metadata + force bit-exact encoding so repeated runs
      // over the same input produce byte-identical output (determinism).
      "-map_metadata", "-1",
      "-fflags", "+bitexact",
      "-flags:a", "+bitexact",
      "-y",
      outputPath,
    ],
  };
}

/**
 * Parse loudnorm's `print_format=json` tail. ffmpeg emits the JSON block in
 * its stderr log; we take the LAST brace-balanced object carrying the four
 * expected keys. `input_i` may legitimately be `-inf` on silent input —
 * that parses to `-Infinity`, which is rejected here (a silent input cannot
 * be meaningfully loudness-normalized).
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurements {
  let lastGood: LoudnessMeasurements | undefined;

  for (const match of stderr.matchAll(/\{[^{}]*\}/g)) {
    try {
      const obj = JSON.parse(match[0] ?? "{}") as Record<string, unknown>;
      const i = Number(obj["input_i"]);
      const tp = Number(obj["input_tp"]);
      const lra = Number(obj["input_lra"]);
      const thresh = Number(obj["input_thresh"]);
      const offset = obj["target_offset"] !== undefined ? Number(obj["target_offset"]) : 0;
      if (
        obj["input_i"] !== undefined &&
        obj["input_tp"] !== undefined &&
        obj["input_lra"] !== undefined &&
        obj["input_thresh"] !== undefined &&
        [i, tp, lra, thresh, offset].every((v) => Number.isFinite(v))
      ) {
        lastGood = { inputI: i, inputTp: tp, inputLra: lra, inputThresh: thresh, targetOffset: offset };
      }
    } catch {
      // not the loudnorm JSON block — keep scanning
    }
  }

  if (!lastGood) {
    throw new NormalizeError(
      "measure",
      "loudnorm did not report a usable measurement (silent input, filter error, or truncated ffmpeg output)",
      stderr.slice(-2000),
    );
  }
  return lastGood;
}
