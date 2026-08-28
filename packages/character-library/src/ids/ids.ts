/**
 * Global character stable business IDs (spec §9).
 *
 * Format: `CHAR_<NAME>_<NNN>` — e.g. `CHAR_MONICA_BENNETT_001`.
 * `<NAME>` is the canonical upper-case slug of the character's name
 * (A–Z/0–9 tokens joined by `_`), `<NNN>` is a 3-digit sequence that makes
 * the ID unique when two characters ever share a name slug.
 *
 * Rules this module enforces:
 * - IDs are STABLE: once minted, a character ID never changes, even if the
 *   character's display name changes later. Display names are mutable prose;
 *   the ID is the permanent key (spec §9 "Permanent IDs").
 * - IDs are never display-name-keyed: the generator keys allocation on the
 *   normalized name slug, never on the raw display string, so "Monica
 *   Bennett", "monica bennett" and "MONICA  BENNETT" resolve to the same
 *   slug and the same allocation sequence.
 * - Validation is strict: a raw display name ("Monica Bennett") is NOT a
 *   valid character ID and every validator rejects it.
 *
 * This module is pure: no database, no I/O. Callers (CORE-005 repositories,
 * CHAR-003 candidate flow) pass the set of already-issued IDs and get the
 * next deterministic ID.
 */

/** Fixed prefix of every MMCS character ID. */
export const CHARACTER_ID_PREFIX = "CHAR";

/** Lowest sequence the generator hands out. */
export const CHARACTER_ID_MIN_SEQUENCE = 1;

/** Highest sequence representable in the 3-digit field. */
export const CHARACTER_ID_MAX_SEQUENCE = 999;

/** Error thrown for invalid character names, slugs, IDs, or exhausted
 * sequences. Message names the exact problem; nothing is silently repaired. */
export class CharacterIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterIdError";
  }
}

/** A name token inside the slug: A–Z/0–9, at least one letter. */
const NAME_TOKEN_RE = /^[A-Z0-9]*[A-Z][A-Z0-9]*$/;

/** The 3-digit sequence field. */
const SEQUENCE_FIELD_RE = /^\d{3}$/;

/** Loose shape check for a character ID: `CHAR_<tokens>_<NNN>`. Structural
 * validation (token content, sequence range) happens in
 * {@link parseCharacterId}; use the parse for real checks. */
export const CHARACTER_ID_PATTERN = /^CHAR_[A-Z0-9_]+_\d{3}$/;

/** Parsed halves of a valid character ID. */
export interface CharacterIdParts {
  /** Name slug, e.g. `"MONICA_BENNETT"`. */
  readonly slug: string;
  /** Numeric sequence, 1–999. */
  readonly sequence: number;
}

/**
 * True when `id` is a well-formed stable character ID
 * (`CHAR_MONICA_BENNETT_001` style). Rejects raw display names, lowercase,
 * missing/oversized sequences, and empty or digit-only name tokens.
 */
export function isValidCharacterId(id: string): boolean {
  return parseCharacterId(id) !== null;
}

/**
 * Parse a character ID into its slug and sequence. Returns `null` for any
 * string that is not exactly the canonical form — including display names,
 * which must never be used as keys.
 */
export function parseCharacterId(id: string): CharacterIdParts | null {
  if (typeof id !== "string") return null;
  const parts = id.split("_");
  if (parts.length < 3) return null;
  const [prefix, ...rest] = parts;
  if (prefix !== CHARACTER_ID_PREFIX) return null;
  const sequenceField = rest[rest.length - 1];
  if (sequenceField === undefined || !SEQUENCE_FIELD_RE.test(sequenceField)) {
    return null;
  }
  const nameTokens = rest.slice(0, -1);
  if (nameTokens.length === 0) return null;
  if (!nameTokens.every((token) => NAME_TOKEN_RE.test(token))) return null;
  const sequence = Number.parseInt(sequenceField, 10);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < CHARACTER_ID_MIN_SEQUENCE ||
    sequence > CHARACTER_ID_MAX_SEQUENCE
  ) {
    return null;
  }
  return { slug: nameTokens.join("_"), sequence };
}

/**
 * Build a character ID from a slug and sequence. Throws
 * {@link CharacterIdError} on an invalid slug or out-of-range sequence —
 * never silently repairs.
 */
export function formatCharacterId(slug: string, sequence: number): string {
  if (!isCanonicalSlug(slug)) {
    throw new CharacterIdError(
      `character slug must be upper-case A-Z/0-9 tokens joined by "_" with at least one letter in each token, got: ${JSON.stringify(slug)}`,
    );
  }
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < CHARACTER_ID_MIN_SEQUENCE ||
    sequence > CHARACTER_ID_MAX_SEQUENCE
  ) {
    throw new CharacterIdError(
      `character ID sequence must be an integer in ${CHARACTER_ID_MIN_SEQUENCE}–${CHARACTER_ID_MAX_SEQUENCE}, got: ${String(sequence)}`,
    );
  }
  return `${CHARACTER_ID_PREFIX}_${slug}_${padSequence(sequence)}`;
}

/** Zero-pad a sequence to the 3-digit ID field. */
export function padSequence(sequence: number): string {
  return String(sequence).padStart(3, "0");
}

/**
 * True when `slug` is a canonical name slug: one or more `_`-joined tokens
 * of A–Z/0–9 where every token contains at least one letter. Digit-only
 * tokens are rejected so the trailing `_<NNN>` sequence field stays
 * unambiguous.
 */
export function isCanonicalSlug(slug: string): boolean {
  if (typeof slug !== "string" || slug.length === 0) return false;
  const tokens = slug.split("_");
  if (tokens.length === 0) return false;
  return tokens.every((token) => NAME_TOKEN_RE.test(token));
}