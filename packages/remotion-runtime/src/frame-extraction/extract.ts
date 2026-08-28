/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildFramePlan, normalizeProvidedFacts } from "./plan.js";
import { DEFAULT_FFPROBE_PATH, ProbeError, probeClip, verifyPngFile } from "./probe.js";
import type {
  ExtractFramesOptions,
  ExtractedFrame,
  FrameExtractionResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Error thrown when an ffmpeg frame dump fails. */
export class FrameExtractionError extends Error {
  override readonly name = "FrameExtractionError";

  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "FrameExtractionError";
  }
}

export const DEFAULT_FFMPEG_PATH = "ffmpeg";

const FRAME_TIMEOUT_MS = 30_000;

/** Single frame dump: one ffmpeg call, exact seek, PNG out. Injectable for tests. */
export type FrameDumpFn = (
  videoPath: string,
  timestampSeconds: number,
  outputPath: string,
  options: { ffmpegPath: string; scale: number; overwrite: boolean; timeoutMs: number },
) => Promise<void>;

export const defaultFrameDump: FrameDumpFn = async (
  videoPath,
  timestampSeconds,
  outputPath,
  { ffmpegPath, scale, overwrite, timeoutMs },
) => {
  // Half-integer-rounded even dimensions keep strict yuv420p encoders happy at any scale.
  const filter = `scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2`;
  const args = [
    "-v", "error",
    "-ss", String(timestampSeconds),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", filter,
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
    throw new FrameExtractionError(
      `ffmpeg failed extracting frame at ${String(timestampSeconds)}s from ${videoPath}: ${detail}`,
      typeof stderr === "string" ? stderr : undefined,
    );
  }
};

/**
 * Extract representative frames from a generated clip for image-vision QC
 * (spec §20 fallback). Probes the clip (or takes provided facts), plans
 * timestamps, dumps one PNG per timestamp via FFmpeg, and verifies every PNG
 * (exists, non-empty, PNG magic) before reporting success — upstream frames.mjs
 * "READ every PNG" discipline.
 */
export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions,
  frameDump: FrameDumpFn = defaultFrameDump,
): Promise<FrameExtractionResult> {
  const { outputDir } = options;
  const scale = options.scale ?? 1;
  const overwrite = options.overwrite ?? false;

  const facts = options.facts
    ? normalizeProvidedFacts(options.facts)
    : await probeClip(videoPath, options.ffprobePath ?? DEFAULT_FFPROBE_PATH);

  const plan = buildFramePlan(
    options.plan ?? { mode: "count", count: 4 },
    { durationSeconds: facts.durationSeconds, fps: facts.fps },
    { scale },
  );

  await mkdir(outputDir, { recursive: true });

  const frames: ExtractedFrame[] = [];
  for (const planned of plan.frames) {
    const outputPath = path.join(outputDir, planned.fileName);
    if (!overwrite) {
      const exists = await stat(outputPath).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new FrameExtractionError(
          `refusing to overwrite existing frame file (pass overwrite:true): ${outputPath}`,
        );
      }
    }
    await frameDump(videoPath, planned.timestampSeconds, outputPath, {
      ffmpegPath: options.ffmpegPath ?? DEFAULT_FFMPEG_PATH,
      scale,
      overwrite,
      timeoutMs: FRAME_TIMEOUT_MS,
    });
    // frames.mjs discipline: verify every PNG before trusting the run.
    const { bytes } = await verifyPngFile(outputPath).catch((error: unknown) => {
      throw new FrameExtractionError(
        `frame verification failed for ${outputPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof ProbeError ? error.stderr : undefined,
      );
    });
    frames.push({ ...planned, filePath: outputPath, bytes });
  }

  return { videoPath, outputDir, facts, plan, frames };
}