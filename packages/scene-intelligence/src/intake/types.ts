/**
 * Idea intake record — the first durable artifact of the writing pipeline
 * (spec §0 "story idea → concept → script…", §24 "collect idea + aspect
 * ratio/runtime", §23 master format).
 *
 * An idea record is the raw creative brief captured before concept
 * development: the user's idea prose, the output aspect ratio, the target
 * runtime, and the series it belongs to (null = standalone movie).
 *
 * SECURITY (spec §29): the idea text is UNTRUSTED DATA. It is stored,
 * compared and transported verbatim (modulo control-character stripping in
 * `sanitize.ts`) and is never interpreted, executed or parsed as
 * instructions by any MMCS code path.
 */

/**
 * The validated idea intake record. Every field is always present; optional
 * inputs normalize to explicit `null` rather than missing keys.
 */
export interface IdeaIntake {
  /** Stable intake ID (`idea_` + 16 random bytes hex), caller-suppliable. */
  readonly intakeId: string;
  /** The user's idea prose. Opaque untrusted data — never executed (spec §29). */
  readonly rawText: string;
  /** Output aspect ratio (spec §23), e.g. "16:9", "9:16", "2.39:1". */
  readonly aspectRatio: string;
  /** Target runtime in seconds (spec §24 "target runtime range"). */
  readonly targetRuntimeSeconds: number;
  /** Owning series ID, or null for a standalone movie (spec §25 projects). */
  readonly seriesLink: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input accepted by {@linkcode parseIntake}; optional fields defaulted. */
export interface IdeaIntakeInput {
  /** Pre-allocated intake ID; omit to generate one. */
  readonly intakeId?: string;
  /** Raw idea prose (untrusted data — stored verbatim, never interpreted). */
  readonly rawText: string;
  /** Output aspect ratio; defaults to "16:9" (spec §23 recommended default). */
  readonly aspectRatio?: string;
  /** Target runtime in seconds. */
  readonly targetRuntimeSeconds: number;
  /** Series ID this idea belongs to; omit/null = standalone movie. */
  readonly seriesLink?: string | null;
  /** Creation timestamp; defaults to now (tests inject a fixed value). */
  readonly createdAt?: string;
}

/** Length bounds for the raw idea text (characters, UTF-16 code units). */
export const IDEA_TEXT_MIN_LENGTH = 1;
export const IDEA_TEXT_MAX_LENGTH = 20_000;

/** Target-runtime bounds in seconds (shorts through ~2h features). */
export const RUNTIME_MIN_SECONDS = 30;
export const RUNTIME_MAX_SECONDS = 7_200;

/** Series-link bounds: opaque ID, no whitespace or control characters. */
export const SERIES_LINK_MAX_LENGTH = 128;

/** Intake-ID bounds: opaque ID, no whitespace or control characters. */
export const INTAKE_ID_MAX_LENGTH = 128;