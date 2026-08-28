/**
 * FFmpeg representative-frame planning + extraction for the image-vision QC
 * route (spec §20 fallback, task QC-005).
 *
 * Mirrors the upstream `remotion/scripts/frames.mjs` discipline (same as
 * VID-016's extractor in remotion-runtime, kept local so qc stays
 * self-contained — packages do not import each other in this repo):
 *  - frames are addressed by integer frame number, 4-digit zero-padded
 *    (`<stem>-f<NNNN>.png`);
 *  - timestamps convert to frames via `local_f = global_s * fps` (round);
 *  - one ffmpeg call per frame, exact `-ss` seek before `-i`;
 *  - every written PNG is verified (exists, non-empty, PNG magic bytes)
 *    before the result is reported.
 *
 * `probeFacts` and `dumpFrame` are injectable ports so tests never need real
 * media; the defaults run the real ffprobe/ffmpeg binaries.
 */

/// <reference types="node" />

import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  QcClipFacts,
  QcExtractedFrame,
  QcPlannedFrame,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Error thrown when ffprobe cannot report the clip's facts. */
export class QcProbeError extends Error {
  override readonly name = "QcProbeError";
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "QcProbeError";
  }
}

/** Error thrown when an ffmpeg frame dump or PNG verification fails. */
export class QcFrameError extends Error {
  override readonly name = "QcFrameError";
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "QcFrameError";
  }
}

export const DEFAULT_FFPROBE_PATH = "ffprobe";
export const DEFAULT_FFMPEG_PATH = "ffmpeg";
/** Default representative frames per clip (start, quarter marks, near-end). */
export const DEFAULT_QC_FRAME_COUNT = 4;
/** Per-frame ffmpeg timeout, ms. */
export const FRAME_DUMP_TIMEOUT_MS = 30_000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Port: report a clip's duration + fps. Injectable for tests. */
export type ProbeFactsFn = (
  videoPath: string,
  ffprobePath: string,
) => Promise<QcClipFacts>;

/** Port: dump one frame as a PNG. Injectable for tests. */
export type DumpFrameFn = (
  videoPath: string,
  timestampSeconds: number,
  outputPath: string,
  options: { ffmpegPath: string; overwrite: boolean; timeoutMs: number },
) => Promise<void>;

/** Default probe via ffprobe's JSON output. */
export const defaultProbeFacts: ProbeFactsFn = async (videoPath, ffprobePath) => {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=r_frame_rate:format=duration",
    "-of",
    "json",
    videoPath,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, args, {
      encoding: "utf8",
      timeout: FRAME_DUMP_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr : String((error as Error).message);
    throw new QcProbeError(
      `ffprobe failed for ${videoPath}: ${detail}`,
      typeof stderr === "string" ? stderr : undefined,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as {
      streams?: { r_frame_rate?: string }[];
      format?: { duration?: string };
    };
  } catch {
    throw new QcProbeError(`ffprobe returned non-JSON output for ${videoPath}`);
  }
  const data = parsed as { streams?: { r_frame_rate?: string }[]; format?: { duration?: string } };
  const rate = data.streams?.[0]?.r_frame_rate; // "num/den"
  const durationRaw = data.format?.duration;
  const parts = typeof rate === "string" ? rate.split("/").map(Number) : [];
  const num = parts[0] ?? NaN;
  const den = parts[1] ?? NaN;
  const duration = typeof durationRaw === "string" ? Number(durationRaw) : NaN;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || !Number.isFinite(duration)) {
    throw new QcProbeError(`ffprobe output missing fps/duration for ${videoPath}`);
  }
  return { durationSeconds: duration, fps: num / den };
};

/** Default frame dump: one ffmpeg call, exact seek, PNG out. */
export const defaultDumpFrame: DumpFrameFn = async (
  videoPath,
  timestampSeconds,
  outputPath,
  { ffmpegPath, overwrite, timeoutMs },
) => {
  const args = [
    "-v",
    "error",
    "-ss",
    String(timestampSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    ...(overwrite ? ["-y"] : ["-n"]),
    outputPath,
  ];
  try {
    await execFileAsync(ffmpegPath, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr : String((error as Error).message);
    throw new QcFrameError(
      `ffmpeg failed extracting frame at ${String(timestampSeconds)}s from ${videoPath}: ${detail}`,
      typeof stderr === "string" ? stderr : undefined,
    );
  }
};

/** frames.mjs conversion: seconds → integer frame number (round). */
export function timestampToFrameNumber(timestampSeconds: number, fps: number): number {
  return Math.round(timestampSeconds * fps);
}

/** frames.mjs file naming: 4-digit zero-padded frame number. */
export function frameFileName(stem: string, frameNumber: number): string {
  return `${stem}-f${String(frameNumber).padStart(4, "0")}.png`;
}

/**
 * Choose `count` evenly-spaced representative timestamps across
 * `[0, duration)` — start inclusive, end exclusive of EOF (a frame at
 * duration would seek past the last frame). Dedupes after frame-number
 * rounding so a sub-frame-interval clip yields distinct frames.
 */
export function representativeTimestamps(
  durationSeconds: number,
  fps: number,
  count = DEFAULT_QC_FRAME_COUNT,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new QcFrameError(`cannot plan frames: invalid duration ${String(durationSeconds)}s`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new QcFrameError(`cannot plan frames: invalid fps ${String(fps)}`);
  }
  const lastFrame = Math.floor(durationSeconds * fps - 1e-9); // last usable frame index
  if (lastFrame < 0) {
    throw new QcFrameError(`clip too short to extract frames (${String(durationSeconds)}s @ ${String(fps)}fps)`);
  }
  const n = Math.max(1, Math.floor(count));
  const timestamps: number[] = [];
  const seenFrames = new Set<number>();
  for (let i = 0; i < n; i++) {
    const frameNumber = Math.round((lastFrame * i) / n);
    if (seenFrames.has(frameNumber)) continue;
    seenFrames.add(frameNumber);
    timestamps.push(frameNumber / fps);
  }
  return timestamps;
}

/** Plan the representative frames (validated, deduped, named). */
export function planFrames(
  facts: QcClipFacts,
  options: { count?: number; stem?: string } = {},
): QcPlannedFrame[] {
  const stem = options.stem ?? "qc-frame";
  return representativeTimestamps(facts.durationSeconds, facts.fps, options.count).map(
    (timestampSeconds, index) => {
      const frameNumber = timestampToFrameNumber(timestampSeconds, facts.fps);
      return { index, timestampSeconds, frameNumber, fileName: frameFileName(stem, frameNumber) };
    },
  );
}

/** Verify a written PNG: exists, non-empty, PNG magic bytes. */
export async function verifyPng(filePath: string): Promise<number> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new QcFrameError(`frame file missing: ${filePath}`);
  if (info.size === 0) throw new QcFrameError(`frame file is empty: ${filePath}`);
  const head = Buffer.alloc(PNG_MAGIC.length);
  const handle = await readFile(filePath);
  handle.copy(head, 0, 0, PNG_MAGIC.length);
  if (!head.equals(PNG_MAGIC)) {
    throw new QcFrameError(`frame file is not a PNG: ${filePath}`);
  }
  return info.size;
}

/**
 * Options for extractRepresentativeFrames().
 */
export interface ExtractQcFramesOptions {
  /** Directory the PNGs are written to (created if missing). */
  outputDir: string;
  /** Representative frame count. Default 4. */
  count?: number;
  /** File-name stem. Default "qc-frame". */
  stem?: string;
  /** Overwrite existing PNGs. Default false (fails instead of clobbering). */
  overwrite?: boolean;
  /** Skip probing: provide facts directly (e.g. from the asset manifest). */
  facts?: QcClipFacts;
  /** ffprobe binary (used only when `facts` is not given). Default "ffprobe". */
  ffprobePath?: string;
  /** ffmpeg binary. Default "ffmpeg". */
  ffmpegPath?: string;
}

/**
 * Extract representative frames from a generated clip for image-vision QC
 * (spec §20 fallback). Probes (or takes provided facts), plans evenly-spaced
 * timestamps, dumps one PNG per timestamp, and verifies every PNG before
 * reporting success.
 */
export async function extractRepresentativeFrames(
  videoPath: string,
  options: ExtractQcFramesOptions,
  ports: { probeFacts?: ProbeFactsFn; dumpFrame?: DumpFrameFn } = {},
): Promise<{ videoPath: string; outputDir: string; facts: QcClipFacts; frames: QcExtractedFrame[] }> {
  const { outputDir } = options;
  const overwrite = options.overwrite ?? false;
  const probeFacts = ports.probeFacts ?? defaultProbeFacts;
  const dumpFrame = ports.dumpFrame ?? defaultDumpFrame;

  const facts = options.facts ?? (await probeFacts(videoPath, options.ffprobePath ?? DEFAULT_FFPROBE_PATH));
  const plan = planFrames(facts, { count: options.count, stem: options.stem });

  await mkdir(outputDir, { recursive: true });

  const frames: QcExtractedFrame[] = [];
  for (const planned of plan) {
    const outputPath = path.join(outputDir, planned.fileName);
    if (!overwrite) {
      const exists = await stat(outputPath).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new QcFrameError(
          `refusing to overwrite existing frame file (pass overwrite:true): ${outputPath}`,
        );
      }
    }
    await dumpFrame(videoPath, planned.timestampSeconds, outputPath, {
      ffmpegPath: options.ffmpegPath ?? DEFAULT_FFMPEG_PATH,
      overwrite,
      timeoutMs: FRAME_DUMP_TIMEOUT_MS,
    });
    const bytes = await verifyPng(outputPath).catch((error: unknown) => {
      throw new QcFrameError(
        `frame verification failed for ${outputPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    frames.push({ ...planned, filePath: outputPath, bytes });
  }

  return { videoPath, outputDir, facts, frames };
}
