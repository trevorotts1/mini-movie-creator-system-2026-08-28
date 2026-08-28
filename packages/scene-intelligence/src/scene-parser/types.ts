/**
 * Scene parser output contract (spec §7, task DIR-009).
 *
 * The parser turns an approved screenplay (plain text or structured) into
 * narrative scenes with per-scene characters, location and an estimated
 * duration. Output is provider-independent: downstream planners (shot
 * planner, scene master, keyframe planner) consume `ParsedScene`, never the
 * screenplay's raw prose.
 */

export type SceneIntExt = "INT" | "EXT" | "INT/EXT" | "UNKNOWN";

/** Parsed scene heading ("INT. DINER - NIGHT"). */
export interface SceneSlug {
  intExt: SceneIntExt;
  /** Interior location path as written ("DINER - KITCHEN"). */
  location: string;
  /** Time-of-day marker ("NIGHT", "CONTINUOUS") or null when absent. */
  timeOfDay: string | null;
}

export interface ParsedDialogueLine {
  /** Speaker name with cue modifiers stripped ("ROSE (V.O.)" -> "ROSE"). */
  character: string;
  /** Parenthetical direction under the cue ("(quiet)") or null. */
  parenthetical: string | null;
  /** Cue modifiers in order of appearance ("V.O.", "CONT'D"). */
  cueModifiers: string[];
  text: string;
}

export interface SceneDurationBreakdown {
  dialogueSeconds: number;
  actionSeconds: number;
}

export interface ParsedScene {
  /** Stable sequential id, `SC01`-style (spec §19 naming convention). */
  sceneId: string;
  /** 1-based document order across the whole screenplay. */
  index: number;
  /** Human-readable scene name; distinct scenes have distinct names. */
  name: string;
  /** Original heading line, or null for synthetic scenes (cold open). */
  heading: string | null;
  slug: SceneSlug | null;
  /** Convenience copy of `slug.location` (null when unknown). */
  location: string | null;
  /** Convenience copy of `slug.timeOfDay` (null when unknown). */
  timeOfDay: string | null;
  /** Ordered unique character names: dialogue speakers first, then action mentions. */
  characters: string[];
  actionLines: string[];
  dialogue: ParsedDialogueLine[];
  durationSeconds: number;
  durationBreakdown: SceneDurationBreakdown;
}

export type SceneParseWarningCode =
  | "EMPTY_SCREENPLAY"
  | "NO_SCENE_HEADINGS"
  | "UNAPPROVED_SCREENPLAY"
  | "INVALID_STRUCTURED_SCREENPLAY"
  | "SCENE_WITHOUT_LOCATION";

export interface SceneParseWarning {
  code: SceneParseWarningCode;
  message: string;
}

export interface ParseResult {
  scenes: ParsedScene[];
  totalDurationSeconds: number;
  warnings: SceneParseWarning[];
  source: "text" | "structured";
}

export interface ParseScreenplayOptions {
  /**
   * Approval state of the input screenplay (Gate 2). `false` never blocks
   * parsing (parsing is a read-only planning step) but marks the result
   * provisional with an `UNAPPROVED_SCREENPLAY` warning.
   */
  approved?: boolean;
  /**
   * Caller-asserted cast names matched case-insensitively inside action
   * prose. Dialogue-speaker-derived names are additionally matched
   * case-sensitively (screenplay action convention: uppercase names).
   */
  knownCharacters?: string[];
  /** Scene ID prefix; defaults to "SC". */
  sceneIdPrefix?: string;
}

/** A structured screenplay scene as produced by upstream generators. */
export interface StructuredScreenplayScene {
  heading?: string | null;
  title?: string | null;
  name?: string | null;
  slug?: {
    intExt?: string | null;
    location?: string | null;
    timeOfDay?: string | null;
  } | null;
  intExt?: string | null;
  location?: string | null;
  timeOfDay?: string | null;
  characters?: string[] | null;
  action?: string | string[] | null;
  dialogue?: StructuredDialogueLine[] | null;
  /** Trustworthy caller-supplied duration override (seconds). */
  estimatedDurationSeconds?: number | null;
}

export interface StructuredDialogueLine {
  character?: string | null;
  speaker?: string | null;
  name?: string | null;
  parenthetical?: string | null;
  cueModifiers?: string[] | null;
  text?: string | null;
  line?: string | null;
}

/** A structured screenplay document as produced upstream (DIR-004 shape). */
export interface StructuredScreenplay {
  approved?: boolean;
  scenes?: StructuredScreenplayScene[] | null;
}