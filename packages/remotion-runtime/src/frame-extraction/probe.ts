/// <reference types="node" />
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ClipFacts } from "./types.js";

const execFileAsync = promisify(execFile);

/** Error thrown when ffprobe fails or returns unusable output. */
export class ProbeError extends Error {
  override readonly name = "ProbeError";

  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export const DEFAULT_FFPROBE_PATH = "ffprobe";

function runProbe(ffprobePath: string, args: string[], videoPath: string): Promise<string> {
  return execFileAsync(ffprobePath, ["-v", "error", ...args, videoPath], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  }).then(
    ({ stdout }) => stdout,
    (error: { stderr?: unknown; message: string }) => {
      const stderr = typeof error.stderr === "string" ? error.stderr : undefined;
      throw new ProbeError(`ffprobe failed for ${videoPath}: ${stderr ?? error.message}`, stderr);
    },
  );
}

function parseNonNegative(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}

function parseFps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parts = value.split("/");
  const num = Number(parts[0]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  if (parts.length < 2) return num;
  const den = Number(parts[1]);
  if (!Number.isFinite(den) || den <= 0) return undefined;
  return num / den;
}

function firstLine(stdout: string): string | undefined {
  return stdout.trim().length > 0 ? stdout.trim().split("\n")[0] : undefined;
}

export function parseFfprobeJson(stdout: string): Omit<ClipFacts, "source"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ProbeError(`ffprobe returned unparseable JSON: ${stdout.slice(0, 200)}`);
  }
  const format = (parsed as { format?: Record<string, unknown> }).format;
  const streams = (parsed as { streams?: Record<string, unknown>[] }).streams;
  const video = Array.isArray(streams)
    ? streams.find((s) => s.codec_type === "video")
    : undefined;
  if (!format || !video) {
    throw new ProbeError("ffprobe JSON missing format/video stream");
  }
  const duration = parseNonNegative(format.duration as string | undefined, "duration");
  if (duration === undefined) throw new ProbeError("ffprobe did not report a usable duration");
  const fps =
    parseFps(video.avg_frame_rate as string | undefined) ??
    parseFps(video.r_frame_rate as string | undefined);
  if (fps === undefined) throw new ProbeError("ffprobe did not report a usable frame rate");
  return {
    durationSeconds: duration,
    fps,
    width: parseNonNegative(video.width as string | undefined, "width"),
    height: parseNonNegative(video.height as string | undefined, "height"),
    codec: typeof video.codec_name === "string" ? video.codec_name : undefined,
  };
}

/** One ffprobe call per field (json-free) — for probes run without -print_format json. */
export function parseFfprobeField(stdout: string): number | undefined {
  return parseNonNegative(firstLine(stdout), "field");
}

/** Probe codec/duration/fps/dimensions of a clip via ffprobe. */
export async function probeClip(
  videoPath: string,
  ffprobePath: string = DEFAULT_FFPROBE_PATH,
): Promise<ClipFacts> {
  const json = await runProbe(
    ffprobePath,
    ["-print_format", "json", "-show_format", "-show_streams"],
    videoPath,
  );
  const facts = parseFfprobeJson(json);
  return { ...facts, source: "probe" };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Verify a dumped PNG is readable: exists, non-empty, PNG magic bytes.
 * Frames.mjs discipline: READ every PNG before trusting the run.
 */
export async function verifyPngFile(filePath: string, minBytes = 1): Promise<{ bytes: number }> {
  const handle = await open(filePath, "r").catch(() => {
    throw new ProbeError(`expected frame file missing: ${filePath}`);
  });
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    const stat = await handle.stat();
    if (stat.size < minBytes) {
      throw new ProbeError(`frame file too small (${String(stat.size)} bytes): ${filePath}`);
    }
    if (bytesRead < 8 || !head.equals(PNG_MAGIC)) {
      throw new ProbeError(`frame file is not a PNG (bad magic): ${filePath}`);
    }
    return { bytes: stat.size };
  } finally {
    await handle.close();
  }
}

/** Absolute binary path when resolvable from PATH; else the name as-is. */
export function resolveBinaryPath(binary: string, searchPath: string = path.delimiter): string {
  if (binary.includes("/") || binary.includes(path.sep)) return binary;
  for (const dir of process.env.PATH?.split(searchPath) ?? []) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}