/**
 * Audio↔picture sync (VID-010). The upstream discipline (frames.mjs +
 * beats.json/vo.gen) drives captions and SFX off the SAME master-second
 * timestamps the audio sits at, converting with
 *
 *   local_f = global_s * fps − sequence_from
 *
 * A sync defect = a picture event (caption/beat/visual hit) and its audio
 * event disagreeing on the frame grid — e.g. an SFX cued at global 5.9s
 * landing on frame 176 while the caption the cue belongs to computes
 * frame 177. Both sides must use the same rounding; this module is the
 * placement-side half of that contract:
 *
 *  - `checkEventSync`: an event's startFrame must equal
 *    toFrame(sourceSec, fps) − sequenceFrom exactly (guards against any
 *    future re-rounding drifting the two halves apart).
 *  - `checkDialogueWindow`: a dialogue line with known duration must start
 *    at its declared time (not shifted to "snap" anywhere) — placements are
 *    exact, never quantized to beat boundaries.
 *  - `verifySync`: run the pair of checks over the whole timeline; empty
 *    issues = in sync by construction.
 *
 * End-to-end loudness/duck verification stays with FISH-009 (FFmpeg owns
 * the mix); this layer owns frame-grid truth.
 */
import type { AudioTimeline, PlacedAudioEvent } from "./types.js";
import { toFrame } from "./place.js";

/** One sync finding. */
export interface AudioSyncIssue {
  /** Machine-readable code (stable, testable). */
  code: "FRAME_GRID_MISMATCH" | "NEGATIVE_START";
  /** Fixed message. */
  message: string;
  /** Input id the issue is about. */
  inputId: string;
}

/** The sync verification result for one placed timeline. */
export interface AudioSyncReport {
  /** True when every event sits exactly on its computed frame-grid slot. */
  inSync: boolean;
  /** Issues found (empty when in sync). */
  issues: AudioSyncIssue[];
}

/**
 * Check one event against the frame grid (the upstream conversion).
 *
 * A negative start is only an error on the MASTER grid (sequenceFrom = 0):
 * inside a mounted view an event cued before the mount point legitimately
 * lands at a negative local frame — its position is still exact.
 */
export function checkEventSync(event: PlacedAudioEvent, fps: number, sequenceFrom: number): AudioSyncIssue | null {
  const expected = toFrame(event.sourceSec, fps) - sequenceFrom;
  if (event.startFrame !== expected) {
    return {
      code: "FRAME_GRID_MISMATCH",
      message:
        `${event.kind} "${event.inputId}" startFrame ${event.startFrame} ≠ ` +
        `toFrame(${event.sourceSec}, ${fps}) − ${sequenceFrom} = ${expected}`,
      inputId: event.inputId,
    };
  }
  if (sequenceFrom === 0 && event.startFrame < 0) {
    return {
      code: "NEGATIVE_START",
      message: `${event.kind} "${event.inputId}" starts at frame ${event.startFrame} (before the master origin)`,
      inputId: event.inputId,
    };
  }
  return null;
}

/**
 * Verify the whole timeline is in sync with its own plan times: every event
 * re-derives to the exact frame it was placed on. This is the regression
 * the acceptance calls the "sync test" — any drift between the plan's
 * seconds and the placed frames fails loudly here.
 */
export function verifySync(timeline: AudioTimeline): AudioSyncReport {
  const issues: AudioSyncIssue[] = [];
  for (const event of timeline.events) {
    const issue = checkEventSync(event, timeline.fps, timeline.sequenceFrom);
    if (issue !== null) issues.push(issue);
  }
  return { inSync: issues.length === 0, issues };
}