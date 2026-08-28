/**
 * Series Bible data shapes (spec §10 "SERIES BIBLE + CANON APPROVAL").
 *
 * "Persistent series canon independent of any LLM conversation: series
 * premise; world rules; characters; relationships; locations; wardrobe;
 * props; visual style; camera language; voice profiles; timeline; prior
 * episode summaries; unresolved plot threads; canon changes (versioned)."
 *
 * Two kinds of state live on the bible:
 *
 * 1. Canon (premise, world rules, characters, relationships, locations,
 *    wardrobe, props, visual style, camera language, voice profiles, plot
 *    threads, per-character canon events). Canon mutates ONLY through
 *    versioned CanonChange records that pass Gate 6 — "No permanent canon
 *    update without user approval". Historical episodes read the canon
 *    state at their time by replaying approved changes whose
 *    effectiveEpisode is at or before the queried episode.
 *
 * 2. Records (episode summaries, timeline events). Append-only factual
 *    history, written as episodes complete; they never need Gate 6.
 */

/** Stable business ID of a character from the global Character Library
 * (spec §9), e.g. "CHAR_MONICA_BENNETT_001". Never a display name. */
export type CharacterId = string;

/** Episode code in the canonical "S<season>E<episode>" shape (spec §9
 * effective-episode convention), e.g. "S01E09". */
export type EpisodeCode = string;

/** One world rule of the series (physics, magic system, society laws). */
export interface WorldRule {
  /** Stable rule ID, e.g. "RULE_TIME_TRAVEL_ONE_WAY". */
  ruleId: string;
  /** The rule statement itself. */
  statement: string;
}

/** A character linked from the global library into this series' cast. */
export interface SeriesCharacterLink {
  /** Global Character Library ID (spec §9 stable business ID). */
  characterId: CharacterId;
  /** Role in the series, e.g. "lead" | "recurring" | "antagonist". */
  role: string;
  /** Episode the character joined the series canon, if known. */
  joinedEpisode?: string;
}

/** A directed relationship between two series characters. */
export interface Relationship {
  /** Stable relationship ID. */
  relationshipId: string;
  /** First character (source of the relationship kind). */
  fromCharacterId: CharacterId;
  /** Second character. */
  toCharacterId: CharacterId;
  /** Relationship kind, e.g. "sibling", "rival", "secret-ally". */
  kind: string;
  /** Free-text continuity notes. */
  notes?: string;
}

/** Reference to a recurring-location master owned by the location library
 * (CHAR-011 / spec §11). The bible stores the linkage, not the angles. */
export interface LocationRef {
  /** Recurring-location master ID from the location library. */
  locationId: string;
  /** Human-readable name for prompt context. */
  name: string;
  notes?: string;
}

/** A wardrobe state a series keeps in continuity (spec §11). */
export interface WardrobeRef {
  /** Character whose wardrobe this is. */
  characterId: CharacterId;
  /** Wardrobe version label from the wardrobe library, e.g. "business-blue-v1". */
  wardrobeVersion: string;
  notes?: string;
}

/** A recurring prop tracked for continuity (spec §11). */
export interface PropRef {
  /** Stable prop ID. */
  propId: string;
  /** Human-readable name. */
  name: string;
  notes?: string;
}

/** Series-level visual style (look, palette, rendering language). */
export interface VisualStyle {
  /** Prose style guide used when compiling visual prompts. */
  styleGuide: string;
  /** Short style tags, e.g. ["warm-noir", "35mm", "rain-slick-streets"]. */
  tags: string[];
}

/** Series-level camera language (framing and motion grammar). */
export interface CameraLanguage {
  /** Camera grammar entries, e.g. ["handheld-for-arguments", "slow-push-in-on-revelations"]. */
  grammar: string[];
  notes?: string;
}

/** Reference to a canonical voice profile bound in the voice-binding
 * module (CHAR-009 / spec §16). */
export interface VoiceProfileRef {
  /** Character the voice belongs to. */
  characterId: CharacterId;
  /** Canonical voice profile ID from the voice-binding store. */
  voiceProfileId: string;
}

/** A per-character canon event, e.g. "Marcus broke his arm" (spec §10
 * proposed-changes example). Append-only, effective from an episode. */
export interface CharacterCanonEvent {
  /** Character the event belongs to. */
  characterId: CharacterId;
  /** What changed in canon, e.g. "broke left arm". */
  event: string;
  /** Episode the event becomes canon from. */
  effectiveEpisode: string;
}

/** Lifecycle of an unresolved/resolved plot thread. */
export type PlotThreadStatus = "open" | "resolved";

/** An unresolved plot thread the series is tracking (spec §10). */
export interface PlotThread {
  /** Stable thread ID. */
  threadId: string;
  /** What the thread is about. */
  description: string;
  /** Episode the thread opened in. */
  openedEpisode: string;
  /** Current lifecycle status. */
  status: PlotThreadStatus;
  /** Episode the thread resolved in, when resolved. */
  resolvedEpisode?: string;
  /** How the thread resolved, when resolved. */
  resolution?: string;
}

/** The mutable canon sections of a series bible (spec §10 list). */
export interface CanonState {
  /** Series premise. */
  premise: string;
  /** World rules currently in canon. */
  worldRules: WorldRule[];
  /** Characters currently linked into the series. */
  characters: SeriesCharacterLink[];
  /** Relationships currently in canon. */
  relationships: Relationship[];
  /** Recurring locations currently in canon. */
  locations: LocationRef[];
  /** Wardrobe states currently tracked. */
  wardrobe: WardrobeRef[];
  /** Props currently tracked. */
  props: PropRef[];
  /** Series visual style. */
  visualStyle: VisualStyle;
  /** Series camera language. */
  cameraLanguage: CameraLanguage;
  /** Voice profile bindings currently in canon. */
  voiceProfiles: VoiceProfileRef[];
  /** Per-character canon events (injuries, moves, discoveries). */
  characterEvents: CharacterCanonEvent[];
  /** Plot threads and their lifecycle. */
  plotThreads: PlotThread[];
}

/** A summary of one produced episode, for "prior episode summaries". */
export interface EpisodeSummary {
  /** Episode the summary describes, e.g. "S01E03". */
  episode: string;
  /** Episode title, if any. */
  title?: string;
  /** What happened, as durable prose (never chat context). */
  summary: string;
}

/** One in-world timeline event (spec §10 "timeline"). */
export interface TimelineEvent {
  /** Stable event ID. */
  eventId: string;
  /** Episode the event was established in. */
  episode: string;
  /** What happened, in world. */
  description: string;
  /** Optional in-world ordering hint (e.g. "before S01E03 opening"). */
  inWorldOrder?: string;
}

/** Approval lifecycle of a canon change (Gate 6, spec §3 gate 6 / §10). */
export type CanonChangeStatus = "PROPOSED" | "APPROVED" | "REJECTED";

/**
 * One unit of proposed canon mutation. Proposed at the end of an episode;
 * nothing touches canon until a user approves it (Gate 6). Approval assigns
 * a sequential `canonVersion` so every canon read is reproducible.
 */
export interface CanonChange {
  /** Stable change ID, e.g. "CC_S01E09_001". Caller-supplied or generated. */
  changeId: string;
  /** Current approval status. */
  status: CanonChangeStatus;
  /** What the change proposes, in one line (review surface). */
  description: string;
  /** Episode the change becomes canon from (e.g. the episode that ended). */
  effectiveEpisode: string;
  /** The concrete mutations, applied in order on approval. */
  mutations: CanonMutation[];
  /** ISO-8601 instant the change was proposed. */
  proposedAt: string;
  /** ISO-8601 instant of approval/rejection, once decided. */
  decidedAt?: string;
  /** Sequential canon version assigned on approval; 1-based. */
  canonVersion?: number;
}

/**
 * A single canon mutation. Applied in listed order when a CanonChange is
 * approved; replayed the same way for canon-at-time reads, so historical
 * episodes see exactly the canon that was live then.
 */
export type CanonMutation =
  | { op: "set_premise"; premise: string }
  | { op: "add_world_rule"; rule: WorldRule }
  | { op: "retire_world_rule"; ruleId: string }
  | { op: "add_character"; link: SeriesCharacterLink }
  | { op: "remove_character"; characterId: CharacterId }
  | { op: "record_character_event"; event: CharacterCanonEvent }
  | { op: "add_relationship"; relationship: Relationship }
  | { op: "add_location"; location: LocationRef }
  | { op: "retire_location"; locationId: string }
  | { op: "add_wardrobe"; wardrobe: WardrobeRef }
  | { op: "add_prop"; prop: PropRef }
  | { op: "set_visual_style"; style: VisualStyle }
  | { op: "set_camera_language"; camera: CameraLanguage }
  | { op: "add_voice_profile"; profile: VoiceProfileRef }
  | { op: "open_plot_thread"; thread: PlotThread }
  | { op: "resolve_plot_thread"; threadId: string; resolvedEpisode: string; resolution?: string };

/** The full Series Bible (spec §10). */
export interface SeriesBible {
  /** Stable series ID, e.g. "SER_HARTWELL_HEIGHTS_001". */
  seriesId: string;
  /** Display title. */
  title: string;
  /** Canon as the series began; immutable starting point for all replays. */
  base: CanonState;
  /** Append-only canon-change ledger (proposed, approved, rejected). */
  canonChanges: CanonChange[];
  /** Append-only prior episode summaries. */
  episodeSummaries: EpisodeSummary[];
  /** Append-only in-world timeline events. */
  timeline: TimelineEvent[];
}