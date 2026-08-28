/**
 * Placement math (VID-010): mix plan (seconds) → placed audio timeline
 * (frames). This is the module's core — it compiles dialogue + music + SFX
 * from the plan onto one fps grid with the upstream frame convention
 * preserved exactly:
 *
 *   local_f = global_s * fps − sequence_from
 *
 * (frames.mjs / Short1Chess: master seconds × fps, minus the sequence mount
 * offset). Times are seconds on the MASTER timeline — the same posture as
 * the upstream `sfx-plan.json` events and `beats.json` VO entries.
 *
 * Determinism: the same plan always yields the same placed timeline
 * (byte-stable, no clock/filesystem/network reads), so the placed timeline
 * can be reviewed or re-rendered after a restart and every re-run is
 * identical — the same reproducibility contract FISH-009's graph compiler
 * holds for argv.
 *
 * Loop friendliness: the upstream loop discipline is last-frame == frame 0
 * (Short1Chess hook/loop geometry, Short6Sheet "last frame == frame 0").
 * The placement grid is aligned to the composition, not wall-clock, so a
 * `totalFrames` equal to the composition duration places every event inside
 * the loop window; `loop.ts` derives the seam constraint (fade-in ==
 * fade-out) that keeps the bed continuous across the wrap.
 */
import type {
  AudioClipInput,
  AudioDialoguePlacement,
  AudioEventKind,
  AudioMusicPlacement,
  AudioSfxCue,
  AudioTimeline,
  AudioTimelinePlan,
  PlacedAudioEvent,
} from "./types.js";
import { AudioPlanError, validateAudioPlan } from "./validate.js";

/** Defaults — echo FISH-009's (same posture, same values). */
export const DEFAULT_BED_GAIN_DB = -7;
export const DEFAULT_DUCK_DB = 9;
export const DEFAULT_FADE_SEC = 1.5;
export const DEFAULT_HIGHPASS_HZ = 90;

/** Dialogue/SFX gain default (FISH-009: plan value or 0 dB). */
export const DEFAULT_LINE_GAIN_DB = 0;

/** Deterministic rounding: half-up on exact .5, banker-free. */
export function toFrame(seconds: number, fps: number): number {
  const exact = seconds * fps;
  return Math.floor(exact + 0.5);
}

/** Build the id → index map (FISH-009 argv order: inputs in plan order). */
function inputIndexMap(inputs: AudioClipInput[]): Map<string, number> {
  const byId = new Map<string, number>();
  inputs.forEach((input, index) => byId.set(input.id, index));
  return byId;
}

/** Resolve kind for a placement input id, rejecting unknown ids + kind mismatches. */
function resolveKind(
  byId: Map<string, number>,
  inputs: AudioClipInput[],
  inputId: string,
  expected: AudioEventKind,
  field: string,
): number {
  const index = byId.get(inputId);
  if (index === undefined) {
    throw new AudioPlanError(`${field} references unknown input id "${inputId}"`);
  }
  const input = inputs[index] as AudioClipInput;
  if (input.kind !== expected) {
    throw new AudioPlanError(
      `${field} references input "${inputId}" of kind "${input.kind}", expected "${expected}"`,
    );
  }
  return index;
}

/** Place one event from its master-timeline seconds. */
function placeEvent(
  inputIndex: number,
  inputId: string,
  kind: AudioEventKind,
  sourceSec: number,
  gainDb: number,
  fadeInSec: number,
  fadeOutSec: number,
  durationSec: number | undefined,
  fps: number,
  sequenceFrom: number,
  extras: Pick<PlacedAudioEvent, "duckDb" | "highpassHz">,
): PlacedAudioEvent {
  return {
    inputId,
    kind,
    startFrame: toFrame(sourceSec, fps) - sequenceFrom,
    sourceSec,
    durationFrames: durationSec === undefined ? null : toFrame(durationSec, fps),
    gainDb,
    fadeInFrames: toFrame(fadeInSec, fps),
    fadeOutFrames: toFrame(fadeOutSec, fps),
    duckDb: extras.duckDb,
    highpassHz: extras.highpassHz,
    inputIndex,
  };
}

/**
 * Place every event of an audio plan on the composition timeline.
 *
 * @param plan          The audio/mix plan (data).
 * @param fps           Composition fps (upstream 30 for the shorts; §1 default 1080x1920@30).
 * @param sequenceFrom  Sequence mount offset in frames (upstream `from=`); 0 for a
 *                      flat composition. Subtracted after the ×fps round.
 * @param totalFrames   Composition length in frames for loop analysis (0 = unknown).
 */
export function placeAudio(
  plan: AudioTimelinePlan,
  fps: number,
  sequenceFrom = 0,
  totalFrames = 0,
): AudioTimeline {
  validateAudioPlan(plan);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new AudioPlanError(`fps must be a finite number in (0, 240]: ${String(fps)}`);
  }
  if (!Number.isInteger(sequenceFrom) || sequenceFrom < 0) {
    throw new AudioPlanError(`sequenceFrom must be a non-negative integer: ${String(sequenceFrom)}`);
  }
  if (!Number.isInteger(totalFrames) || totalFrames < 0) totalFrames = 0;

  const byId = inputIndexMap(plan.inputs);

  const placeDialogue = (line: AudioDialoguePlacement): PlacedAudioEvent =>
    placeEvent(
      resolveKind(byId, plan.inputs, line.inputId, "dialogue", `dialogue "${line.inputId}"`),
      line.inputId,
      "dialogue",
      line.startSec,
      line.gainDb ?? DEFAULT_LINE_GAIN_DB,
      line.fadeInSec ?? 0,
      line.fadeOutSec ?? 0,
      line.durationSec,
      fps,
      sequenceFrom,
      { duckDb: 0, highpassHz: 0 },
    );

  const dialogueEvents = (plan.dialogue ?? []).map(placeDialogue);

  let musicEvent: PlacedAudioEvent | null = null;
  const music: AudioMusicPlacement | undefined = plan.music;
  if (music !== undefined) {
    musicEvent = placeEvent(
      resolveKind(byId, plan.inputs, music.inputId, "music", `music "${music.inputId}"`),
      music.inputId,
      "music",
      0,
      music.gainDb ?? DEFAULT_BED_GAIN_DB,
      music.fadeInSec ?? DEFAULT_FADE_SEC,
      music.fadeOutSec ?? DEFAULT_FADE_SEC,
      undefined,
      fps,
      sequenceFrom,
      {
        duckDb: music.duckDb ?? DEFAULT_DUCK_DB,
        highpassHz: music.highpassHz ?? DEFAULT_HIGHPASS_HZ,
      },
    );
  }

  const placeSfx = (cue: AudioSfxCue): PlacedAudioEvent =>
    placeEvent(
      resolveKind(byId, plan.inputs, cue.inputId, "sfx", `sfx "${cue.inputId}"`),
      cue.inputId,
      "sfx",
      cue.atSec,
      cue.gainDb ?? DEFAULT_LINE_GAIN_DB,
      0,
      0,
      cue.durationSec,
      fps,
      sequenceFrom,
      { duckDb: 0, highpassHz: 0 },
    );

  const sfxEvents = (plan.sfx ?? []).map(placeSfx);

  const events = [...dialogueEvents, ...(musicEvent ? [musicEvent] : []), ...sfxEvents];

  return {
    fps,
    sequenceFrom,
    totalFrames,
    dialogue: dialogueEvents,
    music: musicEvent,
    sfx: sfxEvents,
    events,
  };
}