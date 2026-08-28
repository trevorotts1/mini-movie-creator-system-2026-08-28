/**
 * Concept-generation domain types — DIR-002 (runbook §24 WF03; spec §0
 * "story idea → concept", gate 1 "Concept — developed concept presented").
 *
 * The concept generator turns a validated idea intake record into a
 * DEVELOPED CONCEPT: several distinct concept options (title, logline,
 * premise, tone, visual style, standout moments) plus the director model's
 * recommendation. Gate 1 (DIR-003) presents these options for human
 * approval; no screenplay work happens before that approval.
 *
 * SECURITY (spec §29): idea text and model output are UNTRUSTED DATA. They
 * are transported verbatim into the prompt's data fence, parsed as data, and
 * never executed, shell-evaluated, or re-interpreted as instructions. Error
 * messages stay value-free (no idea text, no raw model output).
 */

/** Mirror of the DIR-001 `IdeaIntake` shape (structural — no import until intake merges). */
export interface IdeaIntakeLike {
  readonly intakeId: string;
  /** Raw idea prose — untrusted data, never executed (spec §29). */
  readonly rawText: string;
  readonly aspectRatio: string;
  readonly targetRuntimeSeconds: number;
  readonly seriesLink: string | null;
  readonly createdAt: string;
}

/** Bounds mirrored from DIR-001 intake until that module merges to integration. */
export const IDEA_TEXT_MIN_LENGTH = 1;
export const IDEA_TEXT_MAX_LENGTH = 20_000;

/** How many concept options one generation produces by default (gate 1 presents all). */
export const CONCEPT_OPTIONS_DEFAULT = 3;
export const CONCEPT_OPTIONS_MIN = 1;
export const CONCEPT_OPTIONS_MAX = 5;

/** One developed concept option produced by the director model. */
export interface ConceptOption {
  /** Stable option ID (`option_N` in generation order). */
  readonly optionId: string;
  readonly title: string;
  readonly logline: string;
  readonly premise: string;
  /** Optional creative descriptors (free text, data only). */
  readonly genre: string | null;
  readonly tone: string | null;
  readonly visualStyle: string | null;
  /** Concrete beats the concept promises; empty when the model gave none. */
  readonly standoutMoments: readonly string[];
  /** Production/continuity risks the director model flags; empty when none. */
  readonly risks: readonly string[];
  /** Suggested runtime override; null = use the intake's target runtime. */
  readonly suggestedRuntimeSeconds: number | null;
  /** Suggested aspect-ratio override; null = use the intake's aspect ratio. */
  readonly suggestedAspectRatio: string | null;
  /** Serialized-episode suggestion; null = standalone movie. */
  readonly suggestedEpisodeCount: number | null;
  /** True for the director model's single recommended option. */
  readonly recommended: boolean;
}

/** Field bounds for response validation (characters). */
export const CONCEPT_FIELD_LIMITS = {
  title: 200,
  logline: 500,
  premise: 4_000,
  descriptor: 1_000,
  listItem: 300,
  listItems: 12,
} as const;

/**
 * Where the prompts came from. Spec §6 doctrine applied to LLM calls: the
 * original idea text lives on the intake; the compiled prompts and their
 * exact character counts are stored together with the result.
 */
export interface ConceptPromptRecord {
  readonly system: string;
  readonly user: string;
  readonly systemChars: number;
  readonly userChars: number;
}

/** Serialized prompt + exact character counts (spec §6 doctrine). */
export type PromptRecord = ConceptPromptRecord;

/** Frozen capability verdict that authorized the director-model call. */
export interface DirectorCapabilitySnapshot {
  readonly modelId: string;
  readonly adapterId: string;
  /** Resolved wire effort; null = reasoning parameter omitted. */
  readonly effort: string | null;
  /** Registry confidence of the profile that cleared the call. */
  readonly confidence: "VERIFIED" | "PROVISIONAL" | "UNKNOWN";
  /** True when the model was called despite having no registry profile (explicit opt-in). */
  readonly unknownModelAllowed: boolean;
  readonly checkedAt: string;
}

/** The generation result handed to gate 1 (DIR-003 approval). */
export interface DevelopedConcept {
  /** Stable concept business ID (`concept_` + 16 random bytes hex). */
  readonly conceptId: string;
  readonly intakeId: string;
  readonly options: readonly ConceptOption[];
  /** ID of the director model's recommended option; always one of `options`. */
  readonly recommendedOptionId: string;
  readonly aspectRatio: string;
  readonly targetRuntimeSeconds: number;
  readonly seriesLink: string | null;
  readonly generatedAt: string;
  readonly generatedBy: DirectorCapabilitySnapshot;
  readonly prompts: ConceptPromptRecord;
  /** Director model's free-text production notes; null when absent. */
  readonly modelNotes: string | null;
  /**
   * Indices of options whose titles matched instruction-shaped patterns.
   * Reporting only (spec §29): the content stays data — it is never executed
   * and the flag never blocks the concept from reaching gate 1.
   */
  readonly flaggedOptionIndexes: readonly number[];
}

/** Input to {@linkcode generateConcept} (see generator.ts). */
export interface ConceptGenerationRequest {
  readonly intake: IdeaIntakeLike;
  /** Capability-checked director model client from `prepareDirectorModel`. */
  readonly client: import("./director-model.js").DirectorModelClient;
  /** Concept options to request; default {@linkcode CONCEPT_OPTIONS_DEFAULT}. */
  readonly optionCount?: number;
  /** Sampling temperature; default 0.8 (creative generation). */
  readonly temperature?: number;
  /** Completion token ceiling; default 4096. */
  readonly maxTokens?: number;
  /** Concept ID override (tests inject a fixed value). */
  readonly conceptId?: string;
  /** Timestamp override (tests inject a fixed value). */
  readonly generatedAt?: string;
}
