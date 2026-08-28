/**
 * Audio fact probing for the normalization pipeline (FISH-008).
 *
 * ACCEPTANCE "probe-before/after": `probeAudio` runs ffprobe on the input
 * BEFORE normalization and on the output AFTER, so every normalize result
 * carries real measured facts on both sides — never an assumed value.
 * Mirrors the VID-016 probe discipline (ffprobe via execFile, JSON parse
 * separated from the spawn so it is unit-testable without the binary).
 */

/// <reference types="node" />
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

import { NormalizeError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Default ffprobe binary — resolved from PATH by ffmpeg's own lookup. */
export const DEFAULT_FFPROBE_PATH = "ffprobe";

/** Audio facts for ONE file, as ffprobe reports them. */
export interface AudioFacts {
  /** Container/format name (e.g. "wav", "mov,mp4,m4a,3gp,3g2,mj2"). */
  formatName: string;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Audio stream codec (e.g. "pcm_s16le", "aac"). */
  codec: string;
  sampleRateHz: number;
  channels: number;
  /** File size in bytes. */
  bytes: number;
}

/**
 * Probe one audio file via ffprobe. Returns the parsed facts plus the raw
 * JSON (callers may re-parse for extra fields).
 */
export async function probeAudio(
  filePath: string,
  ffprobePath: string = DEFAULT_FFPROBE_PATH,
): Promise<AudioFacts> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new NormalizeError("input", `audio file missing or unreadable: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new NormalizeError("input", `not a regular file: ${filePath}`);
  }
  if (fileStat.size === 0) {
    throw new NormalizeError("input", `audio file is empty: ${filePath}`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "--", filePath,
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new NormalizeError(
      "probe",
      `ffprobe failed for ${filePath}: ${typeof stderr === "string" ? stderr : String((error as Error).message ?? error)}`,
      typeof stderr === "string" ? stderr.slice(-2000) : undefined,
    );
  }

  return { ...parseFfprobeAudioJson(stdout), bytes: fileStat.size };
}

/**
 * Parse ffprobe JSON into audio facts. Separated from the spawn so parsing
 * rules are unit-testable without ffprobe on PATH.
 */
export function parseFfprobeAudioJson(stdout: string): Omit<AudioFacts, "bytes"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new NormalizeError("probe", `ffprobe returned unparseable JSON: ${stdout.slice(0, 200)}`);
  }

  const format = (parsed as { format?: Record<string, unknown> }).format;
  const streams = (parsed as { streams?: Record<string, unknown>[] }).streams;
  const audio = Array.isArray(streams)
    ? streams.find((s) => s.codec_type === "audio")
    : undefined;

  if (!format || !audio) {
    throw new NormalizeError("probe", "ffprobe JSON missing format/audio stream");
  }

  const duration = Number(format["duration"]);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new NormalizeError("probe", "ffprobe did not report a usable duration");
  }
  const sampleRate = Number(audio["sample_rate"]);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new NormalizeError("probe", "ffprobe did not report a usable sample rate");
  }
  const channels = Number(audio["channels"]);
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new NormalizeError("probe", "ffprobe did not report a usable channel count");
  }
  const codec = audio["codec_name"];
  if (typeof codec !== "string" || codec.length === 0) {
    throw new NormalizeError("probe", "ffprobe did not report a usable codec");
  }
  const formatName = format["format_name"];
  if (typeof formatName !== "string" || formatName.length === 0) {
    throw new NormalizeError("probe", "ffprobe did not report a usable format name");
  }

  return { formatName, durationSeconds: duration, codec, sampleRateHz: sampleRate, channels };
}
