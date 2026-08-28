/**
 * Loop analysis (VID-010). The MMCS loop discipline (upstream shorts
 * grammar, preserved by spec §21) is: the last frame of the loop equals
 * frame 0 — Short1Chess ("loop's last frame lands on the hook's look"),
 * Short6Sheet ("grow reaches 1.06 by the loop's last frame so it wraps
 * seamlessly onto frame 0"), Short8Phish ("exactly on frame 0 and the replay
 * is seamless").
 *
 * The audio timeline preserves that convention on TWO levels:
 *  1. Frame grid — `totalFrames` is the composition loop length; every
 *     event must land inside [0, totalFrames). Placement never clamps or
 *     shifts beyond the window: an overlay event is an error, not a
 *     truncation, so a loop re-render can never silently drift.
 *  2. Bed seam — the bed wraps, so its amplitude at the seam must match:
 *     fade-in frames == fade-out frames (symmetric fades around frame 0 /
 *     last frame). Non-matching fades produce an audible discontinuity at
 *     the wrap; `analyzeAudioLoop` reports it as a fixable issue, and
 *     `checkLoopFriendly` refuses to declare the timeline loop-friendly.
 *
 * The mix itself (bed looping, absolute durations) is FFmpeg's job
 * (FISH-009); this layer owns the placement-side contract only.
 */
import type { AudioTimeline, PlacedAudioEvent } from "./types.js";

/** One loop-safety finding against the timeline. */
export interface AudioLoopIssue {
  /** Machine-readable code (stable, testable). */
  code: "OVERFLOW" | "BED_SEAM_ASYMMETRIC" | "BED_OFF_GRID" | "UNKNOWN_LENGTH";
  /** Fixed message. */
  message: string;
  /** Input id the issue is about (events only). */
  inputId?: string;
}

/** The analysis result for one placed timeline. */
export interface AudioLoopReport {
  /** The effective loop length in frames (rounded to the fps grid). */
  loopLengthFrames: number;
  /** True when every event fits inside the loop window and the bed seam is continuous. */
  loopFriendly: boolean;
  /** Issues that violate loop friendliness (empty when friendly). */
  issues: AudioLoopIssue[];
  /** Index of the last rendered frame (loopLengthFrames − 1) — the frame that must equal frame 0. */
  lastFrame: number;
}

/**
 * Effective loop length in frames.
 *
 * When a composition length is known (`totalFrames`) it wins. Unknown → the
 * event window: max over events of start + declared duration, else 0. The
 * width of a *loop* is the frame count whose last frame equals frame 0 —
 * same number the video composition declares.
 */
export function loopLengthFrames(timeline: AudioTimeline): number {
  if (timeline.totalFrames > 0) return timeline.totalFrames;
  let end = 0;
  for (const event of timeline.events) {
    const len = event.durationFrames ?? 0;
    end = Math.max(end, event.startFrame + len);
  }
  return end;
}

/** End in frames of one event on the timeline (null when unknown). */
export function eventEndFrame(event: PlacedAudioEvent): number | null {
  return event.durationFrames === null ? null : event.startFrame + event.durationFrames;
}

/** Analyze a placed timeline against the loop-window + seam contract. */
export function analyzeAudioLoop(timeline: AudioTimeline): AudioLoopReport {
  const loopLen = loopLengthFrames(timeline);
  const issues: AudioLoopIssue[] = [];

  if (timeline.totalFrames === 0) {
    issues.push({
      code: "UNKNOWN_LENGTH",
      message: "composition length unknown (totalFrames=0): no strict loop window to check",
    });
  }

  for (const event of timeline.events) {
    const end = eventEndFrame(event);
    if (end === null) continue; // untrimmed native length — FFmpeg clips it
    if (loopLen > 0 && end > loopLen) {
      issues.push({
        code: "OVERFLOW",
        message: `${event.kind} "${event.inputId}" ends at frame ${end}, past the ${loopLen}-frame loop window`,
        inputId: event.inputId,
      });
    }
  }

  const bed = timeline.music;
  if (bed !== null) {
    if (bed.startFrame !== 0) {
      issues.push({
        code: "BED_OFF_GRID",
        message: `music bed starts at frame ${bed.startFrame}, not 0 — the bed must start on the loop origin`,
        inputId: bed.inputId,
      });
    }
    if (loopLen > 0 && bed.fadeInFrames !== bed.fadeOutFrames) {
      const fadeOutStart = Math.max(0, loopLen - bed.fadeOutFrames);
      issues.push({
        code: "BED_SEAM_ASYMMETRIC",
        message:
          `music bed fades in ${bed.fadeInFrames}f but fades out ${bed.fadeOutFrames}f — ` +
          `at the seam (frame ${fadeOutStart} → frame ${loopLen - 1} → frame 0) ` +
          `amplitude jumps; set fadeInFrames == fadeOutFrames`,
        inputId: bed.inputId,
      });
    }
  }

  return {
    loopLengthFrames: loopLen,
    loopFriendly: issues.length === 0,
    issues,
    lastFrame: Math.max(0, loopLen - 1),
  };
}

/**
 * True when the placed timeline is loop-friendly: composition length known,
 * every event inside the window, and (when a bed exists) the bed starts on
 * frame 0 with a symmetric seam fade. A bed-less timeline with everything
 * inside the window IS loop-friendly — the bed is optional per the plan.
 */
export function checkLoopFriendly(timeline: AudioTimeline): AudioLoopReport {
  return analyzeAudioLoop(timeline);
}