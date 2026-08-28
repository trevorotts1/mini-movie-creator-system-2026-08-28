import type { ClipFacts, FramePlan, FramePlanConfig, PlannedFrame } from "./types.js";

/** Error thrown for invalid frame-plan configuration. */
export class FramePlanError extends Error {
  override readonly name = "FramePlanError";

  constructor(message: string) {
    super(message);
    this.name = "FramePlanError";
  }
}

export const DEFAULT_FRAME_COUNT = 4;
export const DEFAULT_SCALE = 1;

/** Tolerance when deriving frame counts from float durations (e.g. 1.9999998). */
const FRAME_GRID_EPSILON = 1e-6;

/**
 * `local_f = global_s * fps - sequence_from` (upstream frames.mjs discipline);
 * standalone clip → sequence_from 0. Rounds to the nearest frame.
 */
export function timestampToFrameNumber(timestampSeconds: number, fps: number): number {
  return Math.round(timestampSeconds * fps);
}

/** frames.mjs file naming: `<stem>-f<NNNN>.png`, 4-digit zero-padded. */
export function frameFileName(stem: string, frameNumber: number): string {
  return `${stem}-f${String(frameNumber).padStart(4, "0")}.png`;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new FramePlanError(`${label} must be a finite positive number, got ${String(value)}`);
  }
}

/** Last usable frame index: floor(duration*fps) - 1 (seeking to t=duration hits EOF). */
export function lastFrameIndex(durationSeconds: number, fps: number): number {
  assertFinitePositive(durationSeconds, "clip duration");
  assertFinitePositive(fps, "fps");
  const total = Math.floor(durationSeconds * fps + FRAME_GRID_EPSILON);
  return total < 1 ? 0 : total - 1;
}

/**
 * Evenly-spaced representative frame indices across [0, lastFrameIndex]:
 * first frame, interior spread, last frame.
 */
export function evenFrameIndices(count: number, lastFrame: number): number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new FramePlanError(`frame count must be an integer >= 1, got ${String(count)}`);
  }
  if (!Number.isInteger(lastFrame) || lastFrame < 0) {
    throw new FramePlanError(`last frame index must be a non-negative integer, got ${String(lastFrame)}`);
  }
  if (count === 1) return [0];
  if (count > lastFrame + 1) {
    // More frames requested than exist: every frame, once.
    return Array.from({ length: lastFrame + 1 }, (_, i) => i);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(Math.round((i * lastFrame) / (count - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Frame indices every `intervalSeconds` worth of frames, always including the last frame. */
export function intervalFrameIndices(
  intervalSeconds: number,
  fps: number,
  lastFrame: number,
): number[] {
  assertFinitePositive(intervalSeconds, "interval");
  if (!Number.isInteger(lastFrame) || lastFrame < 0) {
    throw new FramePlanError(`last frame index must be a non-negative integer, got ${String(lastFrame)}`);
  }
  const step = Math.max(1, Math.round(intervalSeconds * fps));
  const out: number[] = [];
  for (let f = 0; f < lastFrame; f += step) {
    out.push(f);
  }
  out.push(lastFrame);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Resolve a plan config into frame indices. `timestamps` mode clamps
 * out-of-range values — never silently drops them — and rejects empty lists.
 */
export function resolveFrameIndices(
  config: FramePlanConfig,
  fps: number,
  lastFrame: number,
): number[] {
  switch (config.mode) {
    case "count":
      return evenFrameIndices(config.count, lastFrame);
    case "interval":
      return intervalFrameIndices(config.intervalSeconds, fps, lastFrame);
    case "timestamps": {
      if (!Array.isArray(config.timestamps) || config.timestamps.length === 0) {
        throw new FramePlanError("timestamps mode requires a non-empty array");
      }
      const indices: number[] = [];
      for (const ts of config.timestamps) {
        if (!Number.isFinite(ts) || ts < 0) {
          throw new FramePlanError(
            `timestamp must be a finite non-negative number, got ${String(ts)}`,
          );
        }
        indices.push(Math.min(timestampToFrameNumber(ts, fps), lastFrame));
      }
      return [...new Set(indices)].sort((a, b) => a - b);
    }
  }
}

/** Build the full frame plan (grid-exact timestamps + frames.mjs file names). */
export function buildFramePlan(
  config: FramePlanConfig,
  facts: { durationSeconds: number; fps: number },
  options: { scale?: number } = {},
): FramePlan {
  const lastFrame = lastFrameIndex(facts.durationSeconds, facts.fps);
  const scale = options.scale ?? DEFAULT_SCALE;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new FramePlanError(`scale must be a finite positive number, got ${String(scale)}`);
  }
  const indices = resolveFrameIndices(config, facts.fps, lastFrame);
  const frames: PlannedFrame[] = indices.map((frameNumber, index) => ({
    index,
    timestampSeconds: frameNumber / facts.fps,
    frameNumber,
    fileName: frameFileName("frames", frameNumber),
  }));
  return {
    durationSeconds: facts.durationSeconds,
    fps: facts.fps,
    scale,
    frames,
  };
}

/** Validate caller-provided facts (extractFrames facts bypass option). */
export function normalizeProvidedFacts(facts: ClipFacts): ClipFacts {
  assertFinitePositive(facts.durationSeconds, "facts.durationSeconds");
  assertFinitePositive(facts.fps, "facts.fps");
  return { ...facts, source: "provided" };
}

/** Timestamp view of evenFrameIndices: seconds on the frame grid. */
export function evenTimestamps(count: number, durationSeconds: number, fps: number): number[] {
  const lastFrame = lastFrameIndex(durationSeconds, fps);
  return evenFrameIndices(count, lastFrame).map((f) => f / fps);
}

/** Timestamp view of intervalFrameIndices. */
export function intervalTimestamps(
  intervalSeconds: number,
  durationSeconds: number,
  fps: number,
): number[] {
  const lastFrame = lastFrameIndex(durationSeconds, fps);
  return intervalFrameIndices(intervalSeconds, fps, lastFrame).map((f) => f / fps);
}

/** Timestamp view of resolveFrameIndices (sorted, grid-snapped, clamped). */
export function resolveTimestamps(
  config: FramePlanConfig,
  durationSeconds: number,
  fps: number,
): number[] {
  const lastFrame = lastFrameIndex(durationSeconds, fps);
  return resolveFrameIndices(config, fps, lastFrame).map((f) => f / fps);
}