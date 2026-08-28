/**
 * Audio timeline plan + placed shapes (VID-010, spec §21).
 *
 * Spec §21 (Remotion responsibilities): Remotion owns "music/SFX placement"
 * on the episodic timeline; the mixed file itself is FFmpeg's job (FISH-009).
 * The mix plan IS data (FISH-009 `MixPlan`): dialogue lines, one music bed,
 * and SFX cues declared as plain JSON, times on the MASTER timeline in
 * seconds — the same posture as the upstream `sfx-plan.json` events
 * (`at_s`, `gain_db`) and `beats.json` VO entries (`start`/`end`).
 *
 * These types mirror FISH-009's plan shapes STRUCTURALLY (same fields, same
 * defaults, same validation posture). FISH-009 is not yet on integration, so
 * this module owns its own copy rather than importing across the package
 * boundary; at integration the two map 1:1 without rewriting either (the
 * same pattern the character library used for the Fish voice profile).
 *
 * Story/dialogue text is UNTRUSTED data (spec §21.0 posture): it may appear
 * in plan fields for traceability but is never executed and never
 * interpolated — only validated numbers and input ids reach the placed
 * timeline.
 */

/** Audio file kinds the timeline accepts. Mirrors FISH-009 `MixInputKind`. */
export type AudioInputKind = "dialogue" | "music" | "sfx";

/**
 * One audio input file. Mirrors FISH-009 `MixInput`: the episode workspace /
 * asset manifest owns layout; this layer only needs a stable id + path.
 */
export interface AudioClipInput {
  /** Stable id referenced by placements (e.g. "line-01", "bed", "sfx-door"). */
  id: string;
  kind: AudioInputKind;
  /** Absolute or workspace-relative path to an audio-bearing file. */
  path: string;
}

/** Gain in decibels. Negative = quieter. */
export type GainDb = number;

/** A dialogue line placed on the master timeline. Mirrors FISH-009 `MixDialogueLayer`. */
export interface AudioDialoguePlacement {
  /** Input id from `AudioClipInput.id` (must be kind "dialogue"). */
  inputId: string;
  /** Start time on the master timeline, seconds (0-based). */
  startSec: number;
  /** Gain applied before the bus sum. Default 0 dB. */
  gainDb?: GainDb;
  /** Optional fade-in seconds. Default 0 (none). */
  fadeInSec?: number;
  /** Optional fade-out seconds. Default 0 (none). */
  fadeOutSec?: number;
  /**
   * Optional known clip duration in seconds (from ffprobe / FISH-006
   * alignment). Absent = clip's native length; placement still positions
   * the start frame exactly.
   */
  durationSec?: number;
}

/** The music bed: ONE continuous bed covering the loop. Mirrors FISH-009 `MixMusicLayer`. */
export interface AudioMusicPlacement {
  /** Input id from `AudioClipInput.id` (must be kind "music"). */
  inputId: string;
  /** Base bed level in dB. Default -7 dB (felt-not-heard, upstream default). */
  gainDb?: GainDb;
  /** Extra dB the bed drops under dialogue. Default 9. 0 disables ducking. */
  duckDb?: GainDb;
  /**
   * Fade-in seconds at the head of the loop. Default 1.5.
   * Loop-friendly mixes keep this equal to `fadeOutSec` so bed amplitude at
   * frame 0 equals bed amplitude at the seam (see `loop.ts`).
   */
  fadeInSec?: number;
  /** Fade-out seconds at the tail of the loop. Default 1.5. */
  fadeOutSec?: number;
  /** Gentle high-pass so the bed never muddies speech. Default 90 Hz. 0 = off. */
  highpassHz?: number;
}

/** One SFX cue delayed to its cue time. Mirrors FISH-009 `MixSfxCue` (+ the upstream `sfx-plan.json` event shape). */
export interface AudioSfxCue {
  /** Input id from `AudioClipInput.id` (must be kind "sfx"). */
  inputId: string;
  /** Cue time on the master timeline, seconds. */
  atSec: number;
  /** Gain applied to this cue. Default 0 dB. */
  gainDb?: GainDb;
  /** Optional known clip duration in seconds (ffprobe). */
  durationSec?: number;
  /**
   * Optional shot/scene reference (traceability only — mirrors the upstream
   * `sfx-plan.json` `shot` field). Never used for placement math.
   */
  shot?: string;
  /** Optional human cue note (traceability only). */
  cue?: string;
}

/**
 * A complete, serializable audio plan — the audited source of truth for what
 * sits on the audio timeline. Structurally compatible with FISH-009
 * `MixPlan` (plus the traceability-only `shot`/`cue` fields the upstream
 * SFX plans carry).
 */
export interface AudioTimelinePlan {
  /** Plan format version, for evolution without ambiguity. */
  formatVersion: 1;
  /** Every audio file the plan references (dialogue lines, bed, SFX clips). */
  inputs: AudioClipInput[];
  /** Speech lines. Optional — a timeline may be bed+SFX only. */
  dialogue?: AudioDialoguePlacement[];
  /** The single music bed. Optional. */
  music?: AudioMusicPlacement;
  /** Sound-effect cues. Optional. */
  sfx?: AudioSfxCue[];
}

/** Which placement list an event came from. */
export type AudioEventKind = AudioInputKind;

/**
 * One placed audio event on the composition timeline, in FRAMES.
 *
 * Frame math preserves the upstream convention exactly (frames.mjs /
 * Short1Chess: `local_f = global_s * fps − sequence_from`): master seconds ×
 * fps, rounded half-up to the deterministic integer frame, minus the
 * sequence mount offset.
 */
export interface PlacedAudioEvent {
  /** Input id from `AudioClipInput.id`. */
  inputId: string;
  /** dialogue | music | sfx. */
  kind: AudioEventKind;
  /**
   * Placement start on the composition timeline, frames. Master start
   * (`startSec`/`atSec`) × fps − `sequenceFrom`. Music always places at 0.
   */
  startFrame: number;
  /** The master-timeline seconds this event was placed from (audit echo). */
  sourceSec: number;
  /** Declared clip duration in frames, or null when the plan gave none. */
  durationFrames: number | null;
  /** Gain in dB (echo of the plan value or its default). */
  gainDb: number;
  /** Fade-in frames. */
  fadeInFrames: number;
  /** Fade-out frames. */
  fadeOutFrames: number;
  /** Extra dB the bed drops under dialogue (music only; 0 otherwise). */
  duckDb: number;
  /** High-pass Hz (music only; 0 otherwise). */
  highpassHz: number;
  /** 1-based index into `plan.inputs` (FISH-009 argv input order). */
  inputIndex: number;
}

/**
 * The fully placed audio timeline for one composition: every dialogue line,
 * the bed, and every SFX cue, converted to frames on a single fps grid.
 */
export interface AudioTimeline {
  /** Composition fps the placement used. */
  fps: number;
  /** Sequence mount offset (frames) the placement used. */
  sequenceFrom: number;
  /** Composition length in frames the placement assumed (0 = unknown). */
  totalFrames: number;
  /** Dialogue events in plan order. */
  dialogue: PlacedAudioEvent[];
  /** The bed event, when the plan has one. */
  music: PlacedAudioEvent | null;
  /** SFX cues in plan order. */
  sfx: PlacedAudioEvent[];
  /** Every event (dialogue, music, sfx) in plan order. */
  events: PlacedAudioEvent[];
}