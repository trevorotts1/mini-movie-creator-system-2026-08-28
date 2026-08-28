/**
 * Sequence mount helper (VID-010 ↔ VID-003 seam).
 *
 * VID-003's shot timeline maps a shot to its composition slot with the
 * upstream convention `local_f = global_s * fps − sequence_from`; the audio
 * layer mounts onto the SAME offsets. This module takes the episode/scene
 * mount points (scene/sequence `from` values, in frames) and produces one
 * placed audio timeline per mount, or one combined view where every event
 * keeps its MASTER frame (sequenceFrom = 0) and the mount offsets travel
 * WITH the event — the shape a flat single-composition rough cut (VID-012)
 * consumes.
 *
 * Both shapes come from the same `placeAudio` grid, so a per-scene mix and
 * a flat mix can never disagree on where a cue lands.
 */
import type { AudioTimeline, AudioTimelinePlan, PlacedAudioEvent } from "./types.js";
import { placeAudio } from "./place.js";
import { analyzeAudioLoop, type AudioLoopReport } from "./loop.js";
import { verifySync, type AudioSyncReport } from "./sync.js";

/** One mounted audio timeline: placement for one sequence mount point. */
export interface MountedAudioTimeline {
  /** The sequence mount offset (`from=`) this placement is relative to. */
  sequenceFrom: number;
  /** The placed timeline for this mount. */
  timeline: AudioTimeline;
  /** Loop analysis for this mount. */
  loop: AudioLoopReport;
  /** Sync verification for this mount. */
  sync: AudioSyncReport;
}

/** Master-timeline placement: every event at its global frame, sequenceFrom = 0. */
export interface MasterAudioTimeline {
  /** The placed timeline (sequenceFrom = 0). */
  timeline: AudioTimeline;
  /** Loop analysis over the master window. */
  loop: AudioLoopReport;
  /** Sync verification over the master grid. */
  sync: AudioSyncReport;
}

/**
 * Place the plan relative to one sequence mount point (VID-003 `from`).
 * Cue seconds stay MASTER-relative; the mount offset is subtracted exactly
 * as the upstream conversion prescribes.
 */
export function mountAudio(
  plan: AudioTimelinePlan,
  fps: number,
  sequenceFrom: number,
  totalFrames: number,
): MountedAudioTimeline {
  const timeline = placeAudio(plan, fps, sequenceFrom, totalFrames);
  return { sequenceFrom, timeline, loop: analyzeAudioLoop(timeline), sync: verifySync(timeline) };
}

/**
 * Place the plan on the MASTER timeline (sequenceFrom = 0): the flat,
 * whole-episode audio track. Event frames are global; a scene-relative view
 * is recovered by subtracting the scene's mount offset (same conversion,
 * inverse direction).
 */
export function masterAudio(
  plan: AudioTimelinePlan,
  fps: number,
  totalFrames: number,
): MasterAudioTimeline {
  const timeline = placeAudio(plan, fps, 0, totalFrames);
  return { timeline, loop: analyzeAudioLoop(timeline), sync: verifySync(timeline) };
}

/**
 * Master-frame of an event placed inside a mounted timeline: the inverse of
 * the mount conversion (mounted frame + sequenceFrom, re-rounded only if
 * the caller re-derives from seconds — here it is exact integer math).
 */
export function toMasterFrame(event: PlacedAudioEvent, sequenceFrom: number): number {
  return event.startFrame + sequenceFrom;
}

/**
 * Mounted frame of an event given its master frame and the mount offset
 * (the upstream `local_f = global_f − sequence_from`, frames form).
 */
export function toMountedFrame(masterFrame: number, sequenceFrom: number): number {
  return masterFrame - sequenceFrom;
}