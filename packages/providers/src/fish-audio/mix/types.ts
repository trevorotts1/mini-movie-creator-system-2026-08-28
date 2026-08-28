/**
 * Mix-plan data shapes (FISH-009).
 *
 * Runbook §24 WF06-005: "FFmpeg audio normalization/mixing contract tests";
 * §14: "FFmpeg: probing; transcoding; normalization; …; audio utilities".
 * The mix plan IS data (spec §10 asset-manifest posture): dialogue lines,
 * a music bed, and SFX cues are declared as plain JSON, and the mixer
 * compiles them into a DETERMINISTIC FFmpeg filter graph. The same plan
 * always produces the same argv — byte-for-byte — so a mix can be re-run,
 * reviewed, or reproduced after a restart (spec §12 async job safety).
 *
 * Story/dialogue text is UNTRUSTED data (spec §21): it may appear in the
 * plan for traceability but is never executed and never interpolated into
 * the filter graph unescaped; only validated numbers and sanitized
 * file-path-bearing fields reach argv.
 */

/** Audio file kinds the mixer accepts as inputs. */
export type MixInputKind = "dialogue" | "music" | "sfx";

/**
 * One audio input file. Paths are given by the caller (the asset manifest /
 * episode workspace owns layout); the mixer validates existence before use.
 */
export interface MixInput {
  /** Stable ID referenced by layers/cues (e.g. "line-01", "bed", "sfx-door"). */
  id: string;
  kind: MixInputKind;
  /** Absolute or workspace-relative path to an audio-bearing file. */
  path: string;
}

/** Gain in decibels applied to a bus/layer. Negative = quieter. */
export type GainDb = number;

/** The dialogue bus: speech lines placed on the master timeline. */
export interface MixDialogueLayer {
  /** Input ID from `MixInput.id`. */
  inputId: string;
  /** Start time on the master timeline, seconds (0-based). */
  startSec: number;
  /**
   * Caller-provided clip duration in seconds (never probed — determinism).
   * Required to anchor a fade-out on the line's own timeline.
   */
  durationSec?: number;
  /** Gain applied to this line before the bus sum. Default 0 dB. */
  gainDb?: GainDb;
  /** Optional fade-in seconds on this line. Default 0 (none). */
  fadeInSec?: number;
  /** Optional fade-out seconds on this line. Default 0 (none). */
  fadeOutSec?: number;
}

/**
 * The music bed: ONE continuous bed, looped to cover the mix, ducked under
 * dialogue (sidechain) exactly like the upstream audition mixers.
 */
export interface MixMusicLayer {
  /** Input ID from `MixInput.id`. */
  inputId: string;
  /** Base bed level in dB. Default -7 dB (felt-not-heard, upstream default). */
  gainDb?: GainDb;
  /** Extra dB the bed drops under dialogue. Default 9. 0 disables ducking. */
  duckDb?: GainDb;
  /** Fade-in/out seconds at the head/tail of the mix. Default 1.5. */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Gentle high-pass so the bed never muddies speech. Default 90 Hz. 0 = off. */
  highpassHz?: number;
}

/** One SFX cue: a clip delayed to its cue time, gained, summed on the SFX bus. */
export interface MixSfxCue {
  /** Input ID from `MixInput.id`. */
  inputId: string;
  /** Cue time on the master timeline, seconds. */
  atSec: number;
  /** Gain applied to this cue. Default 0 dB. */
  gainDb?: GainDb;
}

/** Master/bed loudness treatment applied to the final sum. */
export interface MixOutputSettings {
  /** Where the mixed file is written. Required. */
  path: string;
  /** Audio codec. Default "aac". */
  codec?: string;
  /** Audio bitrate. Default "192k". */
  bitrate?: string;
  /** Target sample rate. Default 48000. */
  sampleRateHz?: number;
  /** Output channel layout. Default "stereo". */
  channelLayout?: "mono" | "stereo";
  /** Safety limiter ceiling as a linear peak (0 < limit <= 1). Default 0.97. */
  limiterCeiling?: number;
  /** Sidechain threshold for the bed duck, linear. Default 0.03. */
  duckThreshold?: number;
  /** Sidechain ratio for the bed duck. Default 3. */
  duckRatio?: number;
  /** Sidechain attack ms (bed). Default 15. */
  duckAttackMs?: number;
  /** Sidechain release ms (bed). Default 450. */
  duckReleaseMs?: number;
  /**
   * Master timeline length in seconds. Bounds the render (`-t`) and anchors
   * the bed fade-out. Required when the music bed fades out; otherwise
   * optional and no `-t` is emitted.
   */
  durationSec?: number;
}

/** The concrete output file a compiled mix will write. */
export interface MixOutputFile {
  /** Where the mixed file is written. */
  path: string;
  /** Audio codec. */
  codec: string;
  /** Audio bitrate. */
  bitrate: string;
}

/** A complete, serializable mix plan — the audited source of truth for a mix. */
export interface MixPlan {
  /** Plan format version, for evolution without ambiguity. */
  formatVersion: 1;
  /** Every audio file the plan references (dialogue lines, bed, SFX clips). */
  inputs: MixInput[];
  /** Speech lines. Optional — a mix may be bed+SFX only. */
  dialogue?: MixDialogueLayer[];
  /** The single music bed. Optional. */
  music?: MixMusicLayer;
  /** Sound-effect cues. Optional. */
  sfx?: MixSfxCue[];
  /** Output format + duck tuning. Optional. */
  output?: MixOutputSettings;
}

/** The compiled FFmpeg invocation — full argv, reproducible. */
export interface CompiledMix {
  /** Complete ffmpeg argv (no shell): ["ffmpeg","-y", ...]. */
  argv: string[];
  /** The exact filter_complex string (also inside argv; exposed for review). */
  filterGraph: string;
  /** Output file descriptor (last argv element). */
  output: MixOutputFile;
  /** Human-readable echo of what was planned (never contains file contents). */
  summary: {
    dialogueLines: number;
    sfxCues: number;
    hasMusic: boolean;
    musicDucked: boolean;
  };
}

/** Result of executing a compiled mix. */
export interface MixResult {
  output: string;
  /** ffprobe format duration of the output, seconds. */
  durationSec: number;
  /** ffprobe stream summary of the output. */
  streams: { codecType: string; codecName: string }[];
}