/**
 * VID-003 — shot → timeline sequence mapping (spec §12 shot record, §21
 * Remotion/FFmpeg responsibilities).
 *
 * Remotion owns the timeline: each shot becomes a Sequence that mounts at a
 * global frame. The upstream frame-QA discipline defines the local-frame
 * conversion this module MUST preserve:
 *
 *     local_f = round(global_s * fps) − sequence_from
 *
 * `remotion/scripts/frames.mjs` frame-QA and
 * `remotion/src/shots/short-6/Short6Sheet.tsx` both use exactly that
 * convention (`const L = (s) => Math.round(s * 30) − SHEET_FROM;`).
 *
 * Frame math is integer: seconds convert to frames via Math.round once, then
 * all arithmetic is on exact integers. A Sequence for a shot mounts at its
 * `sequenceFrom` global frame and covers local frames `localInFrame` (0) up to
 * but not including `localOutFrame`.
 */

/** Upstream baseline composition rate: 1080x1920@30 (spec §2). */
export const DEFAULT_FPS = 30;

/** The part of a shot record the timeline needs to place the shot (§12). */
export interface ShotTimelineInput {
  /** Stable per-shot identifier, e.g. "SHOT_S01E01_SCENE003_02". */
  shotId: string;
  /** Positional index within the scene/episode; must be unique. */
  sequenceIndex: number;
  /** Intended duration in seconds (may be fractional). */
  durationSeconds: number;
}

/** One shot's resolved placement on the episode timeline. */
export interface TimelineShot {
  shotId: string;
  sequenceIndex: number;
  /** Frames per second the timeline runs at. */
  fps: number;
  /** Global time (seconds) at which the shot starts. */
  startSeconds: number;
  /** Global time (seconds) just past the shot's last frame (exclusive). */
  endSeconds: number;
  durationSeconds: number;
  /**
   * Global frame the shot's Sequence mounts at. Upstream
   * frames.mjs nomenclature: `sequence_from`.
   */
  sequenceFrom: number;
  /** Global frame just past the shot's last frame (exclusive). */
  globalOutFrame: number;
  /** Frames the shot occupies: `globalOutFrame − sequenceFrom`. */
  durationInFrames: number;
  /** First local frame inside the Sequence (always 0). */
  localInFrame: number;
  /** Local frame just past the shot's last frame (exclusive). */
  localOutFrame: number;
}

export interface TimelineOptions {
  /** Frames per second; defaults to the upstream baseline 30 (§2). */
  fps?: number;
}

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

function assertValidInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TimelineError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/** Seconds → global frames: `round(seconds * fps)` (upstream convention). */
export function framesForSeconds(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TimelineError(`seconds must be a finite non-negative number, got ${seconds}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TimelineError(`fps must be a finite positive number, got ${fps}`);
  }
  return Math.round(seconds * fps);
}

/**
 * Upstream local-frame conversion (frames.mjs / Short6Sheet):
 * `local_f = round(global_s * fps) − sequence_from`.
 */
export function localFrame(globalSeconds: number, sequenceFrom: number, fps: number): number {
  assertValidInteger(sequenceFrom, "sequenceFrom");
  return framesForSeconds(globalSeconds, fps) - sequenceFrom;
}

/**
 * Inverse of the local→global mapping: a local frame inside a Sequence mounted
 * at `sequenceFrom` is global frame `localFrame + sequenceFrom`.
 */
export function globalFrameFromLocal(localFrameValue: number, sequenceFrom: number): number {
  assertValidInteger(localFrameValue, "localFrameValue");
  assertValidInteger(sequenceFrom, "sequenceFrom");
  return localFrameValue + sequenceFrom;
}

/**
 * Map an ordered shot list onto the episode timeline.
 *
 * Shots are sorted by `sequenceIndex` (the input order is not significant),
 * placed back-to-back: each shot starts at the cumulative end of the previous
 * one, and every boundary is rounded with `framesForSeconds`. Because both
 * ends round independently, `durationInFrames` may differ from
 * `round(durationSeconds * fps)` by at most one frame — that is the expected
 * quantization, not a gap: shot n+1's `sequenceFrom` always equals shot n's
 * `globalOutFrame`.
 */
export function buildShotTimeline(
  shots: readonly ShotTimelineInput[],
  options: TimelineOptions = {},
): TimelineShot[] {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TimelineError(`fps must be a finite positive number, got ${fps}`);
  }
  const ordered = [...shots].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const seen = new Set<number>();
  const timeline: TimelineShot[] = [];
  let startSeconds = 0;
  for (const shot of ordered) {
    assertValidInteger(shot.sequenceIndex, `sequenceIndex for ${shot.shotId}`);
    if (seen.has(shot.sequenceIndex)) {
      throw new TimelineError(
        `duplicate sequenceIndex ${shot.sequenceIndex} (${shot.shotId} collides with an earlier shot)`,
      );
    }
    seen.add(shot.sequenceIndex);
    const s = framesForSeconds(startSeconds, fps);
    const e = framesForSeconds(startSeconds + shot.durationSeconds, fps);
    timeline.push({
      shotId: shot.shotId,
      sequenceIndex: shot.sequenceIndex,
      fps,
      startSeconds,
      endSeconds: startSeconds + shot.durationSeconds,
      durationSeconds: shot.durationSeconds,
      sequenceFrom: s,
      globalOutFrame: e,
      durationInFrames: e - s,
      localInFrame: 0,
      localOutFrame: e - s,
    });
    startSeconds += shot.durationSeconds;
  }
  return timeline;
}

/** Total episode length in frames (last shot's `globalOutFrame`; 0 when empty). */
export function timelineDurationInFrames(timeline: readonly TimelineShot[]): number {
  const last = timeline.at(-1);
  return last ? last.globalOutFrame : 0;
}

/**
 * The shot occupying a given global frame, or undefined when the frame is out
 * of range. Ranges are half-open: a shot owns global frames
 * `sequenceFrom .. globalOutFrame − 1` inclusive.
 */
export function shotAtGlobalFrame(
  timeline: readonly TimelineShot[],
  globalFrameValue: number,
): TimelineShot | undefined {
  if (!Number.isInteger(globalFrameValue) || globalFrameValue < 0) {
    return undefined;
  }
  for (const shot of timeline) {
    if (globalFrameValue >= shot.sequenceFrom && globalFrameValue < shot.globalOutFrame) {
      return shot;
    }
  }
  return undefined;
}
