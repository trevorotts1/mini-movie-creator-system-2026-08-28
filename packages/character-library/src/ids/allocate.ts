/**
 * Display-name → canonical slug normalization and the deterministic ID
 * allocator (spec §9 "Permanent IDs … never display-name-keyed").
 *
 * The allocator is pure and deterministic: given the same name and the same
 * set of already-issued IDs it always returns the same next ID. It keys on
 * the canonical slug — never on the raw display string — so case/spacing
 * variants of one name share a sequence and cannot collide.
 */

import {
  CHARACTER_ID_MAX_SEQUENCE,
  CHARACTER_ID_MIN_SEQUENCE,
  CharacterIdError,
  formatCharacterId,
  isCanonicalSlug,
  padSequence,
  type CharacterIdParts,
} from "./ids.js";
import { parseCharacterId } from "./ids.js";

/**
 * Normalize a display name to its canonical slug.
 * - trims, collapses internal whitespace/underscores/hyphens to a single
 *   token boundary
 * - upper-cases
 * - drops characters outside A–Z/0–9
 *
 * "Monica Bennett", "monica  bennett", "Monica-Bennett" → `MONICA_BENNETT`.
 * Throws {@link CharacterIdError} when nothing survives (empty, or all
 * punctuation/emoji — a name must contain at least one letter).
 */
export function slugifyCharacterName(displayName: string): string {
  if (typeof displayName !== "string") {
    throw new CharacterIdError(
      `character display name must be a string, got: ${typeof displayName}`,
    );
  }
  const normalized = displayName
    .replace(/[\s_\-.]+/g, "_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!isCanonicalSlug(normalized)) {
    throw new CharacterIdError(
      `cannot derive a stable character ID from the display name ${JSON.stringify(displayName)} — a name needs at least one A-Z letter`,
    );
  }
  return normalized;
}

/** Input to {@link nextCharacterId}: a character's display name. */
export interface CharacterIdRequest {
  /** Human display name, e.g. "Monica Bennett". Mutable prose — only its
   * normalized slug feeds ID allocation. */
  readonly displayName: string;
}

/**
 * Allocate the next stable character ID for a display name.
 *
 * Deterministic: scans the issued IDs for the name's slug and returns the
 * lowest unused sequence (spec-style examples start at 001). Never keys on
 * the display string, so "monica bennett" and "Monica Bennett" allocate
 * into the same sequence.
 *
 * `issued` may be any iterable of existing character IDs (or full ID
 * strings from the DB); malformed entries are ignored rather than trusted.
 * Throws {@link CharacterIdError} when all 999 sequences for the slug are
 * taken.
 */
export function nextCharacterId(
  request: CharacterIdRequest,
  issued: Iterable<string> = [],
): string {
  const slug = slugifyCharacterName(request.displayName);
  return nextCharacterIdForSlug(slug, issued);
}

/**
 * Allocate the next ID for an already-canonical slug. Exported for callers
 * that store slugs (e.g. CORE-005 repositories); same determinism
 * guarantees as {@link nextCharacterId}.
 */
export function nextCharacterIdForSlug(
  slug: string,
  issued: Iterable<string> = [],
): string {
  if (!isCanonicalSlug(slug)) {
    throw new CharacterIdError(
      `character slug must be upper-case A-Z/0-9 tokens joined by "_", got: ${JSON.stringify(slug)}`,
    );
  }
  const used = new Set<number>();
  for (const id of issued) {
    const parsed = parseCharacterId(id);
    if (parsed !== null && parsed.slug === slug) {
      used.add(parsed.sequence);
    }
  }
  for (
    let sequence = CHARACTER_ID_MIN_SEQUENCE;
    sequence <= CHARACTER_ID_MAX_SEQUENCE;
    sequence += 1
  ) {
    if (!used.has(sequence)) {
      return formatCharacterId(slug, sequence);
    }
  }
  throw new CharacterIdError(
    `character ID space exhausted for slug ${slug}: all sequences ${padSequence(CHARACTER_ID_MIN_SEQUENCE)}–${padSequence(CHARACTER_ID_MAX_SEQUENCE)} are issued`,
  );
}

/**
 * Stable-ID comparison helper for callers that must dedupe or sort IDs.
 * Two IDs are the same character iff both parse and their slugs AND
 * sequences match — string equality is sufficient for canonical IDs, but
 * this makes the rule explicit and rejects non-canonical junk.
 */
export function sameCharacterId(a: string, b: string): boolean {
  const pa: CharacterIdParts | null = parseCharacterId(a);
  const pb: CharacterIdParts | null = parseCharacterId(b);
  if (pa === null || pb === null) return false;
  return pa.slug === pb.slug && pa.sequence === pb.sequence;
}