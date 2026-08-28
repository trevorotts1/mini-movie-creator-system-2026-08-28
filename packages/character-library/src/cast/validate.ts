import type { EpisodePoint, SeriesCastLink } from "./types.js";

/**
 * Pure link-integrity validation for series cast links. Throwing keeps the
 * durable store clean: callers cannot persist a link whose effective range
 * or join identity is malformed.
 */

/** A link whose effectiveFrom is not before its effectiveUntil. */
export class InvalidCastRangeError extends Error {
  constructor(seriesId: string, characterId: string) {
    super(
      `Cast link ${seriesId}/${characterId}: effectiveFrom must be earlier than effectiveUntil`,
    );
    this.name = "InvalidCastRangeError";
  }
}

/** A link that does not carry a stable permanent character business ID. */
export class InvalidCharacterIdError extends Error {
  constructor(characterId: string) {
    super(`Cast link carries a non-permanent character ID: "${characterId}"`);
    this.name = "InvalidCharacterIdError";
  }
}

/** Permanent business IDs are `CHAR_<NAME>_<NNN>` style (spec.md §9). */
const PERMANENT_ID_PATTERN = /^CHAR_[A-Z0-9_]+_[0-9]+$/;

export function isValidPermanentCharacterId(characterId: string): boolean {
  return PERMANENT_ID_PATTERN.test(characterId);
}

function isValidEpisodePoint(point: EpisodePoint): boolean {
  return Number.isInteger(point.season) && point.season >= 1
    && Number.isInteger(point.episode) && point.episode >= 1;
}

/**
 * Validates a link before persistence. Throws InvalidCharacterIdError for
 * display-name-keyed IDs and InvalidCastRangeError for inverted ranges.
 * `null` effective bounds are legal (open-ended range).
 */
export function validateCastLink(link: SeriesCastLink): void {
  if (!isValidPermanentCharacterId(link.characterId)) {
    throw new InvalidCharacterIdError(link.characterId);
  }
  if (link.effectiveFrom !== null && !isValidEpisodePoint(link.effectiveFrom)) {
    throw new InvalidCastRangeError(link.seriesId, link.characterId);
  }
  if (
    link.effectiveUntil !== null && !isValidEpisodePoint(link.effectiveUntil)
  ) {
    throw new InvalidCastRangeError(link.seriesId, link.characterId);
  }
  if (link.effectiveFrom !== null && link.effectiveUntil !== null) {
    const from = link.effectiveFrom;
    const until = link.effectiveUntil;
    const inverted = from.season > until.season
      || (from.season === until.season && from.episode >= until.episode);
    if (inverted) {
      throw new InvalidCastRangeError(link.seriesId, link.characterId);
    }
  }
}