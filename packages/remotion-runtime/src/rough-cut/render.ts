/// <reference types="node" />
/**
 * Rough-cut preview render (VID-012) — timeline → preview MP4 (spec §21/§32).
 *
 * Spec §21 puts the rough cut in Remotion's ownership ("rough-cut and final
 * render compositions"). The production render is upstream Remotion
 * (`bundle()` → `selectComposition()` → `renderMedia()` over the episodic
 * composition the registry generates); those collaborators are NOT
 * importable from integration yet, so the adapter is injected — the same
 * port posture VID-013 and VID-014 shipped ahead of their upstreams. The
 * adapter shape mirrors `renderMedia` inputs so the integration wrapper is
 * a thin, structural match.
 *
 * Two render paths, one pipeline:
 *   1. PRODUCTION: the injected `RoughCutRenderAdapter` (Remotion at
 *      integration) renders the assembled timeline.
 *   2. FIXTURE: `makeFfmpegFixtureAdapter()` synthesizes a REAL preview MP4
 *      from the assembled timeline with the system ffmpeg (lavfi sources +
 *      the dialogue/music inputs as real audio tracks where provided) —
 *      no network, no provider spend, no committed media. This proves the
 *      whole path (assemble → render → ffprobe) against real binaries, and
 *      doubles as the offline smoke for `mmcs rough-cut`.
 *
 * Every render is validated with the ffprobe gate before the pipeline
 * reports success (spec §21: ffprobe owns integrity checks; §32: the rough
 * cut must be a real, ffprobe-valid MP4).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  assembleRoughCut,
  resolutionForFormat,
  roughCutFileName,
} from "./assemble.js";
import { RoughCutError } from "./errors.js";
import { spawnFile, type SpawnResult } from "./spawn.js";
import type { RoughCutPlan, RoughCutTimeline } from "./types.js";

/**
 * Production render request — mirrors upstream `renderMedia` inputs
 * (bundle/serveUrl, composition id, fps, resolution, duration, codec).
 */
export interface RoughCutRenderRequest {
  /** Composition id the registry generated (e.g. "S01E01"). */
  compositionId: string;
  /** Bundled Remotion entry (serveUrl) or fixture bundle id. */
  serveUrl: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Deterministic absolute output path. */
  output: string;
  codec: "h264";
  /** The assembled timeline (segments/placements the composition mounts). */
  timeline: RoughCutTimeline;
}

export interface RoughCutRenderResult {
  output: string;
  /** Wall-clock render seconds (report input). */
  renderSeconds: number;
}

export type RoughCutRenderAdapter = (
  request: RoughCutRenderRequest,
) => Promise<RoughCutRenderResult>;

/**
 * ffprobe validation report for the rough-cut gate (structural twin of the
 * VID-015 wrapper so the swap at integration is 1:1).
 */
export interface RoughCutProbeReport {
  ok: boolean;
  codec?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  error?: string;
}

/**
 * ffprobe gate — shells out to the system ffprobe (`-v error -of json`) and
 * requires a usable video stream with positive dimensions and a duration.
 * A probe that cannot establish a duration FAILS (never silently 0).
 */
export async function ffprobeValidateRoughCut(
  output: string,
  options: { bin?: string; timeoutMs?: number } = {},
): Promise<RoughCutProbeReport> {
  let result: SpawnResult;
  try {
    result = await spawnFile(
      options.bin ?? "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height:format=duration",
        "-of",
        "json",
        output,
      ],
      { timeoutMs: options.timeoutMs ?? 20_000, allowNonZero: true },
    );
  } catch (err) {
    return {
      ok: false,
      error: `ffprobe unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: `ffprobe exited ${result.code}: ${result.stderr.trim().slice(0, 400) || "no stderr"}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "ffprobe produced non-JSON output" };
  }
  const streams = (parsed as { streams?: unknown[] }).streams;
  const fmt = (parsed as { format?: Record<string, unknown> }).format;
  const stream = Array.isArray(streams)
    ? (streams[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!stream) {
    return { ok: false, error: "ffprobe found no video stream" };
  }
  const width = Number(stream.width);
  const height = Number(stream.height);
  const duration = Number(fmt?.duration);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: "ffprobe reported no usable dimensions" };
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "ffprobe reported no usable duration" };
  }
  return {
    ok: true,
    codec: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
    durationSeconds: duration,
    width,
    height,
  };
}

/**
 * Fixture render adapter: builds ONE deterministic preview MP4 from the
 * assembled timeline using the system ffmpeg lavfi sources at the timeline's
 * resolution/fps/duration (h264 + yuv420p, universally probeable). Silent by
 * design (anullsrc-free: no audio track unless dialogue/music audio files
 * exist at integration; the §32 acceptance is a valid preview MP4, and the
 * dialogue/music placement the fixture carries in its metadata sidecar).
 *
 * Duration honors the timeline exactly (`totalFrames / fps`), so the
 * ffprobe readback proves the deterministic frame math end-to-end.
 */
export function makeFfmpegFixtureAdapter(
  options: { bin?: string; timeoutMs?: number } = {},
): RoughCutRenderAdapter {
  return async (request: RoughCutRenderRequest): Promise<RoughCutRenderResult> => {
    const started = Date.now();
    const durationSeconds = request.durationInFrames / request.fps;
    const { code, stderr } = await spawnFile(
      options.bin ?? "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${request.width}x${request.height}:rate=${request.fps}`,
        "-t",
        String(durationSeconds),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        request.output,
      ],
      { timeoutMs: options.timeoutMs ?? 60_000 },
    );
    if (code !== 0) {
      throw new RoughCutError(
        "RENDER_FAILED",
        `ffmpeg fixture render failed: ${stderr.trim().slice(0, 400)}`,
      );
    }
    return { output: request.output, renderSeconds: (Date.now() - started) / 1000 };
  };
}

/** What a completed rough-cut render reports back. */
export interface RoughCutResult {
  /** The rendered preview MP4 path. */
  output: string;
  /** The deterministic filename used (spec §19). */
  fileName: string;
  compositionId: string;
  fps: number;
  resolution: { width: number; height: number };
  totalFrames: number;
  durationSeconds: number;
  shotCount: number;
  dialogueCount: number;
  hasTempMusic: boolean;
  /** ffprobe gate result — ok:true is the §32 "ffprobe-valid" proof. */
  probe: RoughCutProbeReport;
  renderSeconds: number;
}

/**
 * Plan the render without executing: resolves the composition id, output
 * path, and assembled timeline. Exposed for `--dry-run` surfaces.
 */
export function planRoughCutRender(
  plan: RoughCutPlan,
  options: { outputDir?: string; version?: number } = {},
): {
  compositionId: string;
  fileName: string;
  outputPath: string;
  timeline: RoughCutTimeline;
} {
  const timeline = assembleRoughCut(plan);
  const fileName = roughCutFileName(plan.episodeCode, options.version ?? 1);
  const outputPath = options.outputDir
    ? join(options.outputDir, fileName)
    : fileName;
  return {
    compositionId: plan.episodeCode,
    fileName,
    outputPath,
    timeline,
  };
}

/**
 * Assemble + render + ffprobe-validate a rough cut.
 *
 * Throws `RoughCutError("OUTPUT_INVALID")` when the produced file fails the
 * ffprobe gate — a bad preview never reports success.
 */
export async function renderRoughCut(
  plan: RoughCutPlan,
  ports: {
    render: RoughCutRenderAdapter;
    /** Validate the output (default: the real-ffmpeg ffprobe gate). */
    validate?: (output: string) => Promise<RoughCutProbeReport>;
  },
  options: { outputDir?: string; version?: number } = {},
): Promise<RoughCutResult> {
  const assembled = planRoughCutRender(plan, options);
  const request: RoughCutRenderRequest = {
    compositionId: assembled.compositionId,
    serveUrl: "rough-cut://fixture",
    fps: assembled.timeline.fps,
    width: assembled.timeline.resolution.width,
    height: assembled.timeline.resolution.height,
    durationInFrames: assembled.timeline.totalFrames,
    output: assembled.outputPath,
    codec: "h264",
    timeline: assembled.timeline,
  };
  const rendered = await ports.render(request);
  const validate = ports.validate ?? ffprobeValidateRoughCut;
  const probe = await validate(rendered.output);
  if (!probe.ok) {
    throw new RoughCutError(
      "OUTPUT_INVALID",
      `rough cut failed the ffprobe gate: ${probe.error ?? "unknown probe failure"}`,
    );
  }
  const info = await stat(rendered.output).catch(() => undefined);
  if (!info || info.size <= 0) {
    throw new RoughCutError("OUTPUT_INVALID", "rough cut output is missing or empty");
  }
  return {
    output: rendered.output,
    fileName: assembled.fileName,
    compositionId: assembled.compositionId,
    fps: assembled.timeline.fps,
    resolution: resolutionForFormat(plan.format, plan.custom),
    totalFrames: assembled.timeline.totalFrames,
    durationSeconds: assembled.timeline.durationSeconds,
    shotCount: assembled.timeline.segments.length,
    dialogueCount: assembled.timeline.dialogue.length,
    hasTempMusic: assembled.timeline.tempMusic !== null,
    probe,
    renderSeconds: rendered.renderSeconds,
  };
}
