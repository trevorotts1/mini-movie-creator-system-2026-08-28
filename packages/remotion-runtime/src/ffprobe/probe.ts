/// <reference types="node" />
/**
 * ffprobe wrapper — reports codec / duration / resolution / bitrate for a
 * media file by shelling out to the system `ffprobe` binary with
 * `-show_streams -show_format -of json` (spec §21: FFmpeg/ffprobe owns
 * probing and integrity checks).
 *
 * The wrapper never trusts the file contents; it only parses what ffprobe
 * returns. Numeric fields that ffprobe reports as strings (duration, bit
 * rate, sample rate) are parsed to numbers and invalid values are dropped
 * (left `undefined`) rather than coerced to 0 — a probe that cannot establish
 * a duration must not silently claim 0.
 */
import { spawn } from "node:child_process";
import { which } from "./which.js";
import {
  FfprobeUnavailableError,
  InvalidProbeOptionsError,
  ProbeFailedError,
  ProbeOutputParseError,
} from "./errors.js";

export { FfprobeUnavailableError, ProbeFailedError } from "./errors.js";

/** How long to wait for ffprobe before killing it (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Default system lookup name for the ffprobe binary. */
export const DEFAULT_FFPROBE_BIN = "ffprobe";

export interface ProbeOptions {
  /** ffprobe binary path or name resolved via PATH. */
  bin?: string;
  /** Kill ffprobe after this many ms (default 30s). */
  timeoutMs?: number;
  /** Optional working directory context (unused by ffprobe itself). */
  cwd?: string;
}

/** One demuxed stream as reported by ffprobe. */
export interface ProbedStream {
  index: number;
  /** `video`, `audio`, `subtitle`, `data`, ... (ffprobe `codec_type`). */
  codecType: string;
  codecName: string | undefined;
  /** Codec long name, when ffprobe reports one. */
  codecLongName: string | undefined;
  /** Pixel dimensions — video streams only. */
  width?: number;
  height?: number;
  /** Display aspect ratio string as reported (e.g. `"9:16"`), video only. */
  displayAspectRatio?: string;
  /** Pixel format (e.g. `yuv420p`), video only. */
  pixFmt?: string;
  /** Frame rate as reported (e.g. `"30/1"`), video only. */
  avgFrameRate?: string;
  /** Audio sample rate in Hz, audio only. */
  sampleRate?: number;
  /** Audio channel count, audio only. */
  channels?: number;
  /** Stream-level bit rate in bits/second, when reported. */
  bitRate?: number;
  /** Stream duration in seconds, when reported. */
  duration?: number;
}

export interface MediaProbe {
  /** Path that was probed (as given). */
  path: string;
  /** Container format name (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  formatName: string | undefined;
  /** Human format long name, when reported. */
  formatLongName: string | undefined;
  /** Container duration in seconds (format-level). */
  durationSeconds: number | undefined;
  /** Overall bit rate in bits/second (format-level). */
  bitRate: number | undefined;
  /** Total stream count ffprobe reports. */
  nbStreams: number | undefined;
  sizeBytes: number | undefined;
  video: ProbedStream | undefined;
  audio: ProbedStream | undefined;
  /** All streams in ffprobe order. */
  streams: ProbedStream[];
  /** Raw ffprobe stdout length, for diagnostics. */
  probeDurationMs: number;
}

/** Shape ffprobe actually emits (strings everywhere it matters). */
interface FfprobeJson {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" && v !== "N/A" ? v : undefined;
}

/**
 * Parse a numeric field ffprobe reports as a string. Returns `undefined` for
 * missing/"N/A"/non-finite values — never 0.
 */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  if (v === "" || v === "N/A") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toStream(raw: Record<string, unknown>, index: number): ProbedStream {
  const codecType = asString(raw.codec_type) ?? "unknown";
  const stream: ProbedStream = {
    index: asNumber(raw.index) ?? index,
    codecType,
    codecName: asString(raw.codec_name),
    codecLongName: asString(raw.codec_long_name),
    bitRate: asNumber(raw.bit_rate),
    duration: asNumber(raw.duration),
  };
  if (codecType === "video") {
    stream.width = asNumber(raw.width);
    stream.height = asNumber(raw.height);
    stream.displayAspectRatio = asString(raw.display_aspect_ratio);
    stream.pixFmt = asString(raw.pix_fmt);
    stream.avgFrameRate = asString(raw.avg_frame_rate);
  }
  if (codecType === "audio") {
    stream.sampleRate = asNumber(raw.sample_rate);
    stream.channels = asNumber(raw.channels);
  }
  return stream;
}

/** Default binary discovery: `FFPROBE_BIN` env override, then PATH lookup. */
async function resolveBin(bin: string | undefined): Promise<string> {
  const candidate = bin ?? process.env.FFPROBE_BIN ?? DEFAULT_FFPROBE_BIN;
  if (candidate.includes("/")) return candidate;
  const found = await which(candidate);
  if (!found) {
    throw new FfprobeUnavailableError(
      `"${candidate}" not found on PATH (set FFPROBE_BIN or pass bin)`,
    );
  }
  return found;
}

export interface RunFfprobeResult {
  stdout: string;
}

/**
 * Run `ffprobe -v error -print_format json -show_format -show_streams` and
 * return raw stdout. Exported for reuse (integrity checks re-probe).
 */
export async function runFfprobe(
  path: string,
  opts: ProbeOptions = {},
): Promise<RunFfprobeResult> {
  if (!path || path.trim() === "") {
    throw new InvalidProbeOptionsError("path is required");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidProbeOptionsError("timeoutMs must be a positive number");
  }
  const bin = await resolveBin(opts.bin);

  return await new Promise<RunFfprobeResult>((resolve, reject) => {
    const child = spawn(bin, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "--",
      path,
    ], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfprobeUnavailableError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT" || err.code === "EACCES") {
        reject(new FfprobeUnavailableError(`${bin}: ${err.message}`));
      } else {
        reject(new FfprobeUnavailableError(err.message));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split("\n").slice(-4).join("\n");
        reject(new ProbeFailedError(path, code, tail));
        return;
      }
      resolve({ stdout });
    });
  });
}

/**
 * Probe a media file and return codec/duration/resolution/bitrate in a
 * structured {@link MediaProbe}. Throws {@link ProbeFailedError} when the
 * file is unreadable/corrupt and {@link FfprobeUnavailableError} when the
 * binary is missing.
 */
export async function probeMedia(
  path: string,
  opts: ProbeOptions = {},
): Promise<MediaProbe> {
  const startedAt = Date.now();
  const { stdout } = await runFfprobe(path, opts);

  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeJson;
  } catch (err) {
    throw new ProbeOutputParseError("stdout is not valid JSON", err);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ProbeOutputParseError("stdout JSON is not an object");
  }

  const rawStreams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const streams = rawStreams.map((s, i) => toStream(s ?? {}, i));
  const format = parsed.format ?? {};
  const first = (type: string) => streams.find((s) => s.codecType === type);

  return {
    path,
    formatName: asString(format.format_name),
    formatLongName: asString(format.format_long_name),
    durationSeconds: asNumber(format.duration),
    bitRate: asNumber(format.bit_rate),
    nbStreams: asNumber(format.nb_streams),
    sizeBytes: asNumber(format.size),
    video: first("video"),
    audio: first("audio"),
    streams,
    probeDurationMs: Date.now() - startedAt,
  };
}
