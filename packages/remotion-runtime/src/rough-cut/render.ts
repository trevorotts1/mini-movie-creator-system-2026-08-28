/// <reference types="node" />
/**
 * Rough-cut preview render (VID-012) — timeline → preview MP4 (spec §21/§32).
 *
 * Spec §21 puts the rough cut in Remotion's ownership ("rough-cut and final
 * render compositions"). The production render drives the upstream Remotion
 * sequence (`bundle()` → `selectComposition()` → `renderMedia()`) through
 * `makeRemotionRenderAdapter()`; the adapter is still injected as a port (the
 * caller owns which entry point/composition to bundle), and its request shape
 * mirrors `renderMedia` inputs so a hand-written adapter stays a thin
 * structural match.
 *
 * Two render paths, one pipeline:
 *   1. PRODUCTION: `makeRemotionRenderAdapter()`
 *      (../final-render/remotion-renderer.ts) bundles the composition and
 *      renders it through `@remotion/renderer` — the real upstream
 *      `bundle() → selectComposition() → renderMedia()` sequence.
 *   2. TEST FIXTURE ONLY: `makeFfmpegFixtureAdapter()` synthesizes a preview
 *      MP4 with the system ffmpeg (lavfi test pattern) — no network, no
 *      provider spend, no committed media. It proves the whole path
 *      (assemble → render → ffprobe) against real binaries, and doubles as the
 *      offline smoke for `mmcs rough-cut`. It is NOT the render path: it never
 *      mounts a composition or draws a frame of the episode.
 *
 * The request no longer carries a fabricated `serveUrl`: a bundle that does
 * not exist cannot have a URL, and passing a fake one made every adapter look
 * wired while nothing was ever bundled. The genuine adapter resolves its entry
 * point from `entryPoint` (request or adapter option) and bundles it.
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
 * (composition id, fps, resolution, duration, codec).
 */
export interface RoughCutRenderRequest {
  /** Composition id the registry generated (e.g. "S01E01"). */
  compositionId: string;
  /**
   * Remotion bundle entry point — the file that calls `registerRoot()` and
   * registers this composition (upstream: `remotion/src/index.ts`), or a
   * pre-built serve URL. Optional: the adapter may own it
   * (`makeRemotionRenderAdapter({ entryPoint })`, or `MMCS_REMOTION_ENTRY`).
   * When NO adapter knows an entry point the render fails with
   * `REMOTION_ENTRY_POINT_MISSING` — it never falls back to a test pattern.
   */
  entryPoint?: string;
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
 * TEST FIXTURE adapter (NOT the render path): builds ONE deterministic preview
 * MP4 from a lavfi test pattern using the system ffmpeg at the timeline's
 * resolution/fps/duration (h264 + yuv420p, universally probeable). It mounts no
 * composition and renders none of the episode's frames — it exists so the
 * assemble → render → ffprobe plumbing can be exercised against real binaries
 * offline. Production renders use `makeRemotionRenderAdapter()`
 * (../final-render/remotion-renderer.ts).
 *
 * Silent by design (no audio track unless dialogue/music audio files exist at
 * integration; the §32 acceptance is a valid preview MP4, and the
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
 * `options.entryPoint` names the Remotion bundle entry for adapters that need
 * one (`makeRemotionRenderAdapter` accepts it here or in its own options).
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
  options: { outputDir?: string; version?: number; entryPoint?: string } = {},
): Promise<RoughCutResult> {
  const assembled = planRoughCutRender(plan, options);
  const request: RoughCutRenderRequest = {
    compositionId: assembled.compositionId,
    fps: assembled.timeline.fps,
    width: assembled.timeline.resolution.width,
    height: assembled.timeline.resolution.height,
    durationInFrames: assembled.timeline.totalFrames,
    output: assembled.outputPath,
    codec: "h264",
    timeline: assembled.timeline,
    ...(options.entryPoint ? { entryPoint: options.entryPoint } : {}),
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
