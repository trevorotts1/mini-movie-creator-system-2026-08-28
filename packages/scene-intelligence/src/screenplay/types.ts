/**
 * Screenplay types — DIR-004 (runbook §24, spec §3 gate 2 / §14 writer model).
 *
 * A screenplay is the structured output of the writer model given an APPROVED
 * concept (spec §3 gate 1: "no screenplay work before approval"). The
 * structured record — scenes, dialogue, characters — is the machine contract
 * consumed downstream by DIR-005 (runtime estimator), DIR-006 (script critic),
 * DIR-007 (revision loop), DIR-008 (script approval gate) and DIR-009 (scene
 * parser). Story/script text is UNTRUSTED DATA (spec §29): every string here
 * is carried as data only and is never interpreted or executed.
 *
 * Schema version: screenplay.schema/v1. Bump on breaking shape changes; the
 * generator stamps every produced screenplay with the version it emitted.
 */

/** Current screenplay output schema version. */
export const SCREENPLAY_SCHEMA_VERSION = "screenplay.schema/v1";

/**
 * Approval states an idea/concept record can carry. Only APPROVED concepts
 * may enter screenplay generation (spec §3 gate 1).
 */
export type ConceptApprovalState = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";

/**
 * The subset of the approved concept record the generator needs. DIR-001/002/003
 * own the richer intake/concept records; this structural interface is the seam
 * (spec §55: split shared seams behind interfaces) — any concept object
 * satisfying it (including the future DIR-003 record) is accepted.
 */
export interface ApprovedConcept {
  /** Stable concept id from the concept generator (DIR-002). */
  conceptId: string;
  /** Working title of the episode/movie. */
  title: string;
  /** One-paragraph pitch the writer model expands. */
  logline: string;
  /** The original user idea text, verbatim. Untrusted — data only. */
  idea: string;
  /** Named story characters the writer should build the cast around. */
  characters: readonly ConceptCharacterSeed[];
  /** Where/when the story takes place (prose). */
  setting: string;
  /** Narrative tone/genre guidance (e.g. "cozy mystery, light humor"). */
  tone: string;
  /** Target episode runtime in seconds (drives scene-count guidance). */
  targetRuntimeSeconds: number;
  /** Master aspect ratio selected at series creation (spec §23); default 16:9. */
  aspectRatio: string;
  /** Approval evidence from gate 1 (spec §3). */
  approval: { state: ConceptApprovalState; approvedAt?: string };
}

/** A character seed from the concept. Not yet a Character Library ID. */
export interface ConceptCharacterSeed {
  /** Display name (prose); the canonical CHAR_* ID comes from the library later. */
  name: string;
  /** Short description for the writer model. */
  description: string;
  /** True when the script is expected to introduce this character as new. */
  isNew?: boolean;
}

/** One spoken line in a scene's dialogue track. */
export interface ScreenplayDialogueLine {
  /** Stable line id, `<sceneId>_L<NN>`. */
  lineId: string;
  /** Scene the line belongs to. */
  sceneId: string;
  /** Display name of the speaking character (matches a cast name). */
  characterName: string;
  /** Optional acting direction, e.g. "(quietly)". */
  parenthetical?: string;
  /** The spoken words. Untrusted data only. */
  text: string;
}

/** A narrative scene in the screenplay. Not a generation shot (spec §7). */
export interface ScreenplayScene {
  /** Scene id `SC<NN>` (1-based, zero-padded). */
  sceneId: string;
  /** 1-based order in the episode. */
  sequenceIndex: number;
  /** Slugline heading, e.g. "INT. OFFICE - DAY". */
  heading: string;
  /** INT./EXT. location type. */
  interiorExterior: "INT" | "EXT";
  /** Location name as written in the heading. */
  location: string;
  /** Time of day from the heading (DAY/NIGHT/CONTINUOUS/...). */
  timeOfDay: string;
  /** What happens — action/direction prose for this scene. Untrusted data. */
  synopsis: string;
  /** Cast names appearing in this scene (subset of screenplay cast). */
  characterNames: readonly string[];
  /** Ordered dialogue for the scene. */
  dialogue: readonly ScreenplayDialogueLine[];
  /** Writer's estimate of scene length in seconds (DIR-005 refines later). */
  estimatedDurationSeconds: number;
}

/** A named character in the produced screenplay cast. */
export interface ScreenplayCharacter {
  /** Display name; unique within the screenplay. */
  name: string;
  /** lead | supporting | cameo. */
  role: "lead" | "supporting" | "cameo";
  /** Who they are, from concept seeds plus what the writer established. */
  description: string;
  /** True when the screenplay introduces this character as new — triggers the
   *  3-candidate Character Library flow downstream (spec §8). */
  isNew: boolean;
}

/** Provenance of one screenplay generation (spec §48 provenance doctrine). */
export interface ScreenplayGenerationMetadata {
  /** ISO-8601 timestamp of generation. */
  generatedAt: string;
  /** Routing slug of the writer model used (e.g. an OpenRouter model id). */
  writerModelId: string;
  /** Reasoning effort requested from the writer model. */
  reasoningEffort: string | null;
  /** Exact character count of the user prompt sent to the writer model. */
  promptCharacterCount: number;
  /** Exact character count of the raw writer response. */
  responseCharacterCount: number;
  /** Schema version of the emitted structure. */
  schemaVersion: string;
}

/** The structured screenplay record (acceptance: scenes, dialogue, characters). */
export interface Screenplay {
  /** Stable screenplay id `SCR_<slug-of-title>_<NNN>`. */
  screenplayId: string;
  /** Concept the screenplay was generated from. */
  conceptId: string;
  /** Episode/movie title. */
  title: string;
  /** Logline carried through from the approved concept. */
  logline: string;
  /** Ordered narrative scenes. */
  scenes: readonly ScreenplayScene[];
  /** Full cast of the screenplay. */
  characters: readonly ScreenplayCharacter[];
  /** Generation provenance. */
  metadata: ScreenplayGenerationMetadata;
}