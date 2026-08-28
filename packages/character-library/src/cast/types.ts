/**
 * Series cast links (spec.md §9, §10).
 *
 * The Global Character Library exists outside individual episodes; series link
 * characters from the global library into their cast. Removing a series cast
 * link must never touch the global character itself — this module's ports
 * deliberately expose no delete operation on the global library.
 */

/** Global character asset lifecycle states (spec.md §9). */
export type CharacterAssetState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

/**
 * Minimal global-library record the cast layer needs. The canonical identity
 * asset payload (GHL IDs, SHA-256, reference packs) stays behind the global
 * library's own modules; casting resolves by ID and never duplicates canon.
 */
export interface GlobalCharacterRecord {
  /** Stable permanent business ID, e.g. `CHAR_MONICA_BENNETT_001`. */
  characterId: string;
  displayName: string;
  /** Currently active identity/appearance version in the global library. */
  activeIdentityVersion: string | null;
  /** Currently active appearance version in the global library. */
  activeAppearanceVersion: string | null;
  /** Currently active voice profile bound in the global library. */
  activeVoiceProfileId: string | null;
  state: CharacterAssetState;
}

/** A point in series time: season/episode, both 1-based. */
export interface EpisodePoint {
  season: number;
  episode: number;
}

/** How a character participates in a series. */
export type CastStatus = "series-regular" | "recurring" | "guest";

/**
 * One global character joined into one series cast.
 *
 * Effective range semantics (spec.md §9 identity versioning, §10 canon-at-
 * time): `effectiveFrom` null means from the series start; `effectiveUntil`
 * null means never removed. `effectiveUntil` is EXCLUSIVE — a link with
 * `effectiveUntil = { season: 1, episode: 9 }` still resolves at S01E08 and
 * no longer resolves at S01E09, matching the "v2 effective S01E09" rule.
 */
export interface SeriesCastLink {
  seriesId: string;
  /** Global library character ID — the join key. Never display-name-keyed. */
  characterId: string;
  status: CastStatus;
  effectiveFrom: EpisodePoint | null;
  effectiveUntil: EpisodePoint | null;
  /**
   * Series-specific appearance override; when null the global library's
   * active appearance version applies at resolution time.
   */
  appearanceVersion: string | null;
  /** Series-specific voice override; when null the global binding applies. */
  voiceProfileId: string | null;
  /** ISO-8601 instant the link was created (audit trail). */
  linkedAt: string;
}

/** A cast member fully resolved against the global library for one episode. */
export interface ResolvedCastMember {
  seriesId: string;
  characterId: string;
  status: CastStatus;
  effectiveFrom: EpisodePoint | null;
  effectiveUntil: EpisodePoint | null;
  /** Series override if set, otherwise the global active version. */
  appearanceVersion: string | null;
  /** Series override if set, otherwise the global active voice profile. */
  voiceProfileId: string | null;
  /** Snapshot of the global record at resolution time. */
  globalCharacter: GlobalCharacterRecord;
}

/** States eligible to be cast into a series (spec.md §9 — APPROVED+ reuse). */
const CASTABLE_STATES: ReadonlySet<CharacterAssetState> = new Set([
  "APPROVED",
  "CANONICAL",
]);

export function isCastableState(state: CharacterAssetState): boolean {
  return CASTABLE_STATES.has(state);
}

/** -1 if `a` is earlier than `b`, 0 if equal, 1 if later. */
export function compareEpisodePoints(
  a: EpisodePoint,
  b: EpisodePoint,
): -1 | 0 | 1 {
  if (a.season !== b.season) return a.season < b.season ? -1 : 1;
  if (a.episode !== b.episode) return a.episode < b.episode ? -1 : 1;
  return 0;
}

/** True when `link`'s effective range covers `point`. */
export function linkCoversEpisode(
  link: SeriesCastLink,
  point: EpisodePoint,
): boolean {
  const fromOk =
    link.effectiveFrom === null ||
    compareEpisodePoints(link.effectiveFrom, point) <= 0;
  const untilOk =
    link.effectiveUntil === null ||
    compareEpisodePoints(point, link.effectiveUntil) < 0;
  return fromOk && untilOk;
}

/** Mutable fields of a cast link (identity of the link never changes). */
export type SeriesCastLinkPatch = Partial<
  Pick<
    SeriesCastLink,
    | "status"
    | "effectiveFrom"
    | "effectiveUntil"
    | "appearanceVersion"
    | "voiceProfileId"
  >
>;