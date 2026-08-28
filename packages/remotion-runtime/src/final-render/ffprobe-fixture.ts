/// <reference types="node" />
// Real-ffmpeg fixture validator + renderer (VID-014) — proves the pipeline's
// validation step against the actual ffprobe binary (spec §21: "ffprobe
// passes"; runbook §24 acceptance: "final file passes ffprobe").
//
// This module is the DEFAULT MediaValidator: it shells out to the system
// ffprobe (PATH; ffmpeg/ffprobe are repo prerequisites per CLAUDE.md) and
// parses codec/duration/resolution/bitrate. Pipeline tests use it against a
// REAL fixture mp4 so the VID-015 contract is exercised end-to-end, while
// the pure-logic tests stay on injected stubs.
//
// The fixture renderer generates a tiny deterministic mp4 via the system
// ffmpeg lavfi testsrc — no network, no provider spend, no committed media
// (output goes to a temp dir).

import { spawnFile } from "./spawn.js";
import type {
  ProbeReport,
  RenderRequest,
  RenderResult,
  RenderAdapter,
} from "./pipeline.js";
import type { Resolution } from "./contract.js";

/**
 * ffprobe wrapper — the VID-015 shape (codec/duration/resolution/bitrate +
 * integrity pass/fail). VID-015's canonical wrapper supersedes this at
 * integration; the shape matches so the swap is structural.
 */
export async function ffprobeValidate(output: string): Promise<ProbeReport> {
  const { code, stdout, stderr } = await spawnFile(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height:format=duration,bit_rate",
      "-of",
      "json",
      output,
    ],
    { timeoutMs: 20_000, allowNonZero: true },
  );
  if (code !== 0) {
    return {
      ok: false,
      error: `ffprobe exited ${code}: ${stderr.trim().slice(0, 400) || "no stderr"}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "ffprobe produced non-JSON output" };
  }
  const streams = (parsed as { streams?: unknown[] }).streams;
  const fmt = (parsed as { format?: Record<string, unknown> }).format;
  const stream = Array.isArray(streams) ? (streams[0] as Record<string, unknown> | undefined) : undefined;
  if (!stream) {
    return { ok: false, error: "ffprobe found no video stream" };
  }
  const width = Number(stream.width);
  const height = Number(stream.height);
  const duration = Number(fmt?.duration);
  const bitrate = Number(fmt?.bit_rate);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: "ffprobe reported no usable dimensions" };
  }
  return {
    ok: true,
    codec: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
    durationSeconds: Number.isFinite(duration) ? duration : undefined,
    resolution: { width, height },
    bitrateKbps: Number.isFinite(bitrate) ? Math.round(bitrate / 1000) : undefined,
  };
}

/**
 * Fixture render adapter: produces a small deterministic mp4 with the system
 * ffmpeg (lavfi testsrc), writes it to `request.output` (a temp path), and
 * reports composition-real metadata. Duration/fps/resolution honor the
 * request so the ffprobe readback proves the render path end-to-end.
 */
export function makeFfmpegFixtureAdapter(): RenderAdapter {
  return async (request: RenderRequest): Promise<RenderResult> => {
    const started = Date.now();
    const { code, stderr } = await spawnFile(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${request.resolution.width}x${request.resolution.height}:rate=${request.fps}`,
        "-t",
        String(Math.min(request.durationSeconds, 2)),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        request.output,
      ],
      { timeoutMs: 60_000 },
    );
    if (code !== 0) {
      throw new Error(`ffmpeg fixture render failed: ${stderr.trim().slice(0, 400)}`);
    }
    return { output: request.output, renderSeconds: (Date.now() - started) / 1000 };
  };
}

/** Standard fixture composition size for fast renders. */
export const FIXTURE_RESOLUTION: Resolution = { width: 320, height: 180 };