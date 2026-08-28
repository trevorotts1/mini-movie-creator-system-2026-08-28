/// <reference types="node" />
/**
 * Media integrity checks (spec §21: FFmpeg/ffprobe owns integrity checks;
 * §20/§28: every render output is validated before ARCHIVED).
 *
 * Two layers:
 * 1. {@link checkIntegrity} — structural validation: the file must probe
 *    cleanly (ffprobe exits 0 with parseable streams) and satisfy the
 *    caller's constraints (duration bounds, resolution, video+audio codecs,
 *    minimum bitrate). Truncated/corrupt files fail here: ffprobe either
 *    exits non-zero or reports no usable duration/streams.
 * 2. {@link verifyPlayback} — decode verification: actually decodes the
 *    container with `ffmpeg -v error -i <file> -f null -` and fails when any
 *    frame or packet errors occur. This catches corruption that metadata
 *    probing alone can miss (bitstream damage inside an intact header).
 *
 * Gate helpers:
 * - {@link validateRenderOutput} — the pre-ARCHIVED gate for render outputs.
 *   Wraps both layers and throws {@link MediaIntegrityError} on failure so a
 *   render pipeline cannot mark a bad file ARCHIVED.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { runFfprobe } from "./probe.js";
import {
  FfprobeUnavailableError,
  ProbeFailedError,
  InvalidProbeOptionsError,
} from "./errors.js";
import { which } from "./which.js";
import { MediaIntegrityError } from "./media-integrity-error.js";

export { MediaIntegrityError };

/** Default minimum duration the gate accepts for any render output (s). */
export const MIN_RENDER_DURATION_SECONDS = 0.1;

export interface IntegrityConstraints {
  /** Reject when duration < min (default {@link MIN_RENDER_DURATION_SECONDS}). */
  minDurationSeconds?: number;
  /** Reject when duration > max. */
  maxDurationSeconds?: number;
  /** Require exactly this pixel width (video files). */
  expectedWidth?: number;
  /** Require exactly this pixel height (video files). */
  expectedHeight?: number;
  /** Require these codec names (e.g. `["h264"]`) on the video stream. */
  expectedVideoCodec?: string;
  /** Require these codec names (e.g. `["aac"]`) on the audio stream. */
  expectedAudioCodec?: string;
  /** Reject when overall bit rate < min bits/s (video files). */
  minBitRate?: number;
  /** Require at least one video stream (default true for the render gate). */
  requireVideo?: boolean;
  /** Require at least one audio stream (default false). */
  requireAudio?: boolean;
}

export interface IntegrityCheckResult {
  ok: boolean;
  path: string;
  /** Human-readable failure reason(s); empty when ok. */
  failures: string[];
  /** Duration (s), when the probe established one. */
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitRate?: number;
}

/** Structural check: probe + constraints. Never throws for bad media —
 * returns `ok:false` with failure reasons (environment failures still throw). */
export async function checkIntegrity(
  path: string,
  constraints: IntegrityConstraints = {},
): Promise<IntegrityCheckResult> {
  const failures: string[] = [];

  // Cheap existence/size gate first — gives precise reasons.
  try {
    const st = await stat(path);
    if (!st.isFile()) failures.push("path is not a regular file");
    else if (st.size === 0) failures.push("file is empty (0 bytes)");
  } catch {
    failures.push("file does not exist or is unreadable");
    return { ok: false, path, failures };
  }

  let durationSeconds: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let videoCodec: string | undefined;
  let audioCodec: string | undefined;
  let bitRate: number | undefined;
  let hasVideo = false;
  let hasAudio = false;

  try {
    const { stdout } = await runFfprobe(path);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    for (const s of streams) {
      const type = typeof s.codec_type === "string" ? s.codec_type : "";
      if (type === "video") {
        hasVideo = true;
        videoCodec =
          typeof s.codec_name === "string" ? s.codec_name : undefined;
        width = typeof s.width === "number" ? s.width : undefined;
        height = typeof s.height === "number" ? s.height : undefined;
      }
      if (type === "audio") {
        hasAudio = true;
        audioCodec =
          typeof s.codec_name === "string" ? s.codec_name : undefined;
      }
    }
    const fmt = parsed.format ?? {};
    durationSeconds =
      typeof fmt.duration === "string" && fmt.duration !== "N/A"
        ? Number(fmt.duration)
        : undefined;
    bitRate =
      typeof fmt.bit_rate === "string" && fmt.bit_rate !== "N/A"
        ? Number(fmt.bit_rate)
        : undefined;
  } catch (err) {
    if (err instanceof ProbeFailedError) {
      failures.push(`ffprobe could not parse the file: ${err.stderrTail || err.message}`);
      return { ok: false, path, failures };
    }
    // Environment failure (binary missing) is not a media verdict — rethrow.
    throw err;
  }

  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
    failures.push("duration could not be established (corrupt or unsupported container)");
  }
  if (!hasVideo && constraints.requireVideo !== false) {
    failures.push("no video stream found");
  }

  const minDur = constraints.minDurationSeconds ?? MIN_RENDER_DURATION_SECONDS;
  if (
    durationSeconds !== undefined &&
    Number.isFinite(minDur) &&
    durationSeconds < minDur
  ) {
    failures.push(
      `duration ${durationSeconds.toFixed(3)}s < minimum ${minDur}s`,
    );
  }
  const maxDur = constraints.maxDurationSeconds;
  if (
    maxDur !== undefined &&
    durationSeconds !== undefined &&
    Number.isFinite(maxDur) &&
    durationSeconds > maxDur
  ) {
    failures.push(`duration ${durationSeconds.toFixed(3)}s > maximum ${maxDur}s`);
  }
  if (constraints.expectedWidth !== undefined && width !== constraints.expectedWidth) {
    failures.push(`width ${width} != expected ${constraints.expectedWidth}`);
  }
  if (constraints.expectedHeight !== undefined && height !== constraints.expectedHeight) {
    failures.push(`height ${height} != expected ${constraints.expectedHeight}`);
  }
  if (constraints.expectedVideoCodec !== undefined && videoCodec !== constraints.expectedVideoCodec) {
    failures.push(`video codec ${videoCodec ?? "unknown"} != expected ${constraints.expectedVideoCodec}`);
  }
  if (constraints.expectedAudioCodec !== undefined && audioCodec !== constraints.expectedAudioCodec) {
    failures.push(`audio codec ${audioCodec ?? "unknown"} != expected ${constraints.expectedAudioCodec}`);
  }
  if (constraints.minBitRate !== undefined && bitRate !== undefined && bitRate < constraints.minBitRate) {
    failures.push(`bitrate ${bitRate} < minimum ${constraints.minBitRate}`);
  }
  if (constraints.requireAudio === true && !hasAudio) {
    failures.push("no audio stream found");
  }

  return {
    ok: failures.length === 0,
    path,
    failures,
    durationSeconds,
    width,
    height,
    videoCodec,
    audioCodec,
    bitRate,
  };
}

export interface VerifyPlaybackResult {
  ok: boolean;
  /** Decoding error lines ffmpeg reported (`-v error`). */
  errors: string[];
}

/** Default decode-verify timeout (ms). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/**
 * Decode-verify a media file end to end with ffmpeg. Every frame is decoded;
 * any error line means corruption. Truncated MP4s typically fail here with
 * `moov atom not found` or invalid-data errors even when ffprobe metadata
 * survives.
 */
export async function verifyPlayback(
  path: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<VerifyPlaybackResult> {
  if (!path || path.trim() === "") {
    throw new InvalidProbeOptionsError("path is required");
  }
  const bin = opts.bin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const resolved = bin.includes("/")
    ? bin
    : (await which(bin)) ?? bin;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  return await new Promise<VerifyPlaybackResult>((resolve, reject) => {
    const child = spawn(resolved, [
      "-v",
      "error",
      "-xerror",
      "-i",
      path,
      "-f",
      "null",
      "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfprobeUnavailableError(`ffmpeg decode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfprobeUnavailableError(`${resolved}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errors = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      resolve({ ok: code === 0 && errors.length === 0, errors });
    });
  });
}

export interface ValidateRenderOutputOptions {
  constraints?: IntegrityConstraints;
  /** Also decode-verify with ffmpeg (default true — full integrity). */
  decodeVerify?: boolean;
  probe?: { bin?: string; timeoutMs?: number };
}

/**
 * The pre-ARCHIVED gate: validate a rendered output file before the asset
 * state machine may advance to ARCHIVED (spec §18/§28). Throws
 * {@link MediaIntegrityError} on any failure; resolves with the probe-derived
 * summary on success.
 */
export async function validateRenderOutput(
  path: string,
  opts: ValidateRenderOutputOptions = {},
): Promise<IntegrityCheckResult> {
  const result = await checkIntegrity(path, opts.constraints ?? {});
  if (!result.ok) {
    throw new MediaIntegrityError(path, result.failures);
  }
  if (opts.decodeVerify !== false) {
    const playback = await verifyPlayback(path, opts.probe);
    if (!playback.ok) {
      throw new MediaIntegrityError(path, playback.errors.slice(0, 5));
    }
  }
  return result;
}
