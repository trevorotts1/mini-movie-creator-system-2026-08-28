/**
 * Rough cut assembly data shapes (VID-012, spec §21/§23/§32).
 *
 * The rough cut is the FIRST assembled preview of a full episode: the shot
 * plan (DIR-010) + the archived per-shot assets (spec §19) + the dialogue
 * lines (FISH-003/006/007) + the temp music bed are assembled into ONE
 * episodic preview MP4 for automated QC and Gate 5 human approval (spec §3).
 *
 * These types are the structural contract between this module and its
 * upstream collaborators. VID-003 (shot timeline), VID-004 (captions),
 * VID-010 (audio timeline) are NOT importable from integration yet (separate
 * branches, merged independently), so this module owns structural twins of
 * their documented shapes — the same dependency-injection posture CAP-009,
 * CHAR-004, VID-013 and VID-014 used ahead of their upstreams. At
 * integration the shapes map 1:1 without rewriting either side.
 *
 * Untrusted data (spec §29): shot ids, asset refs, dialogue keys and titles
 * are carried verbatim as inert field values. They are validated
 * STRUCTURALLY (non-empty strings, finite numbers) and are never executed,
 * never parsed for content, and never used to build anything but validated
 * numbers and ids on the timeline.
 */

/** Master output formats (spec §23: chosen once per series, episode override). */
export type MasterFormat = "16:9" | "9:16" | "custom";

/** A resolved render resolution in pixels. */
export interface Resolution {
  readonly width: number;
  readonly height: number;
}

/**
 * The four visual layer kinds (spec §22, structural twin of VID-013's
 * `ShotLayerKind`): generated character video, AI still with camera motion,
 * stock/B-roll, native Remotion graphics.
 */
export type RoughCutLayerKind = "generated-video" | "still-motion" | "stock" | "graphics";

/** One planned shot in the rough-cut assembly (structural twin of the
 * VID-002 `ShotPlan` + VID-013 `ShotSegment` input subset). */
export interface RoughCutShotInput {
  /** Stable per-shot identifier (spec §12). Untrusted — carried verbatim. */
  readonly shotId: string;
  /** Positional index within the episode; must be unique. */
  readonly sequenceIndex: number;
  /** Planned duration in seconds (DB `target_duration`). */
  readonly targetDurationSeconds: number;
  /** Which of the four §22 media kinds supplies the pixels. */
  readonly layerKind: RoughCutLayerKind;
  /**
   * Archived asset reference (spec §19: canonical GHL URL / library path
   * token from the DB asset record — never a bare filename guess).
   * REQUIRED for generated-video / still-motion / stock shots: the rough cut
   * assembles from ARCHIVED assets. Native graphics shots need none.
   */
  readonly assetRef?: string;
}

/** One dialogue line placed on the master timeline (structural twin of the
 * VID-010 `AudioDialoguePlacement`). Times are MASTER-timeline seconds. */
export interface RoughCutDialogueInput {
  /** Stable line id. Untrusted — carried verbatim. */
  readonly dialogueId: string;
  /** Dialogue asset key (FISH-005 cache key / asset manifest id). */
  readonly assetKey: string;
  /** Start time on the master timeline, seconds (0-based). */
  readonly startSec: number;
  /** Optional known duration in seconds (FISH-006 alignment). */
  readonly durationSec?: number;
  /** Optional shot reference — traceability only, never used for math. */
  readonly shotId?: string;
}

/** The single temp music bed (structural twin of the VID-010 music layer). */
export interface RoughCutTempMusicInput {
  /** Archived music asset reference (spec §19). */
  readonly assetRef: string;
  /** Bed level in dB. Default -7 (felt-not-heard, upstream default). */
  readonly gainDb?: number;
}

/** Plan format version, for evolution without ambiguity. */
export const ROUGH_CUT_PLAN_VERSION = 1;

/** A complete rough-cut plan for one episode — the audited input. */
export interface RoughCutPlan {
  readonly formatVersion: typeof ROUGH_CUT_PLAN_VERSION;
  readonly seriesId: string;
  readonly episodeId: string;
  /** Episode code for deterministic naming, e.g. "S01E01" (spec §19). */
  readonly episodeCode: string;
  /** Series master format; per-episode override is applied by the caller. */
  readonly format: MasterFormat;
  /** Required when `format` is "custom" (spec §23 custom aspect). */
  readonly custom?: Resolution;
  /** Composition fps; defaults to the upstream baseline 30 (spec §2). */
  readonly fps?: number;
  /** Ordered shots (any input order; assembled by `sequenceIndex`). */
  readonly shots: readonly RoughCutShotInput[];
  /** Dialogue lines. Optional. */
  readonly dialogue?: readonly RoughCutDialogueInput[];
  /** The single temp music bed. Optional. */
  readonly tempMusic?: RoughCutTempMusicInput;
}

/** Master-format → master resolution (spec §23 defaults). */
export const RESOLUTION_16_9: Resolution = { width: 1920, height: 1080 };
export const RESOLUTION_9_16: Resolution = { width: 1080, height: 1920 };

/** One shot's resolved placement on the assembled rough-cut timeline. */
export interface RoughCutSegment {
  readonly shotId: string;
  readonly sequenceIndex: number;
  readonly layerKind: RoughCutLayerKind;
  /** Archived asset ref echo (null for native graphics shots). */
  readonly assetRef: string | null;
  /** Global frame the shot's Sequence mounts at (upstream `sequence_from`). */
  readonly sequenceFrom: number;
  /** Global frame just past the shot's last frame (exclusive). */
  readonly globalOutFrame: number;
  /** Frames the shot occupies: `globalOutFrame − sequenceFrom`. */
  readonly durationInFrames: number;
  /** Planned seconds echo. */
  readonly targetDurationSeconds: number;
}

/** One dialogue line placed in FRAMES on the assembled timeline. */
export interface PlacedRoughCutDialogue {
  readonly dialogueId: string;
  readonly assetKey: string;
  /** Placement start in frames (master `startSec` × fps, rounded once). */
  readonly startFrame: number;
  /** Declared duration in frames, or null when the plan gave none. */
  readonly durationFrames: number | null;
  /** Master seconds echo (audit). */
  readonly sourceSec: number;
}

/** The fully assembled rough-cut timeline — deterministic, in FRAMES. */
export interface RoughCutTimeline {
  readonly fps: number;
  readonly format: MasterFormat;
  /** Master resolution for the format (fixture/production adapters scale it). */
  readonly resolution: Resolution;
  /** Total episode length in frames (last shot's `globalOutFrame`). */
  readonly totalFrames: number;
  /** Total length in seconds (exact: `totalFrames / fps`). */
  readonly durationSeconds: number;
  /** Shots in assembly order (by `sequenceIndex`). */
  readonly segments: readonly RoughCutSegment[];
  /** Dialogue lines in plan order. */
  readonly dialogue: readonly PlacedRoughCutDialogue[];
  /** The temp music bed, or null when the plan has none. Music always
   * starts at frame 0 and covers the whole episode (upstream bed posture). */
  readonly tempMusic: { readonly assetRef: string; readonly gainDb: number } | null;
}
