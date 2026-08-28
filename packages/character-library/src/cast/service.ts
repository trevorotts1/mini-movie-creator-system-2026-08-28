/**
 * Cast service (spec.md §9): joins global-library characters into per-series
 * casts and resolves the cast for a given episode.
 *
 * Invariants enforced here:
 * - Casting references the global library by ID only — a link never copies
 *   canon data, so resolution always reflects the canon-at-time record.
 * - Only APPROVED/CANONICAL global characters may join a cast.
 * - Removing a series cast link deletes the LINK, never the global character
 *   (the service holds only a GlobalCharacterReader, which has no delete).
 */

import {
  linkCoversEpisode,
  type CastStatus,
  type EpisodePoint,
  type GlobalCharacterRecord,
  type ResolvedCastMember,
  type SeriesCastLink,
  type SeriesCastLinkPatch,
  isCastableState,
} from "./types.js";
import {
  NotInCastError,
  UnknownCharacterError,
  type GlobalCharacterReader,
  type SeriesCastStore,
} from "./ports.js";
import { validateCastLink } from "./validate.js";

export interface CastServiceDeps {
  globalCharacters: GlobalCharacterReader;
  castStore: SeriesCastStore;
  /** Clock for the `linkedAt` audit stamp; defaults to `Date.now`. */
  now?: () => Date;
}

export interface LinkCharacterInput {
  seriesId: string;
  characterId: string;
  status?: CastStatus;
  effectiveFrom?: EpisodePoint | null;
  effectiveUntil?: EpisodePoint | null;
  /** Series-specific appearance override. */
  appearanceVersion?: string | null;
  /** Series-specific voice override. */
  voiceProfileId?: string | null;
}

export class CastService {
  private readonly globalCharacters: GlobalCharacterReader;
  private readonly castStore: SeriesCastStore;
  private readonly now: () => Date;

  constructor(deps: CastServiceDeps) {
    this.globalCharacters = deps.globalCharacters;
    this.castStore = deps.castStore;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Links a global-library character into a series cast. Fails when the
   * global ID is unknown or the character is not APPROVED/CANONICAL.
   */
  async linkCharacter(input: LinkCharacterInput): Promise<SeriesCastLink> {
    const global = await this.globalCharacters.get(input.characterId);
    if (global === null) {
      throw new UnknownCharacterError(input.characterId);
    }
    if (!isCastableState(global.state)) {
      throw new Error(
        `Character ${input.characterId} is ${global.state}; only APPROVED or CANONICAL characters can join a cast`,
      );
    }
    const link: SeriesCastLink = {
      seriesId: input.seriesId,
      characterId: input.characterId,
      status: input.status ?? "series-regular",
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveUntil: input.effectiveUntil ?? null,
      appearanceVersion: input.appearanceVersion ?? null,
      voiceProfileId: input.voiceProfileId ?? null,
      linkedAt: this.now().toISOString(),
    };
    validateCastLink(link);
    await this.castStore.add(link);
    return link;
  }

  /** Lists every cast link of a series, regardless of effective range. */
  async listCast(seriesId: string): Promise<SeriesCastLink[]> {
    return this.castStore.listBySeries(seriesId);
  }

  /**
   * Resolves the cast of a series at one episode: links covering the episode
   * point, joined to their canon-at-time global records, with series
   * overrides falling back to the global active versions.
   */
  async resolveCastForEpisode(
    seriesId: string,
    point: EpisodePoint,
  ): Promise<ResolvedCastMember[]> {
    const links = await this.castStore.listBySeries(seriesId);
    const covering = links.filter((link) => linkCoversEpisode(link, point));
    const resolved: ResolvedCastMember[] = [];
    for (const link of covering) {
      const global = await this.globalCharacters.get(link.characterId);
      if (global === null) {
        // Global character vanished through means outside this module; the
        // link cannot resolve without it and is reported as absent rather
        // than fabricating a record.
        continue;
      }
      resolved.push({
        seriesId: link.seriesId,
        characterId: link.characterId,
        status: link.status,
        effectiveFrom: link.effectiveFrom,
        effectiveUntil: link.effectiveUntil,
        appearanceVersion: link.appearanceVersion ?? global.activeAppearanceVersion,
        voiceProfileId: link.voiceProfileId ?? global.activeVoiceProfileId,
        globalCharacter: global,
      });
    }
    return resolved;
  }

  /**
   * Removes a character from a series cast by ending the link.
   *
   * The global character is untouched: this module only ever holds a reader
   * over the global library, and the store contract forbids deleting global
   * records on link removal. The link itself is removed from the store.
   */
  async unlinkCharacter(seriesId: string, characterId: string): Promise<void> {
    const link = await this.castStore.get(seriesId, characterId);
    if (link === null) {
      throw new NotInCastError(seriesId, characterId);
    }
    await this.castStore.remove(seriesId, characterId);
  }

  /**
   * Ends a link at an episode without deleting it — the link keeps its
   * history (spec.md §10 canon-at-time) while no longer resolving from that
   * episode on (`effectiveUntil` is exclusive).
   */
  async endCastAt(
    seriesId: string,
    characterId: string,
    until: EpisodePoint,
  ): Promise<void> {
    const link = await this.castStore.get(seriesId, characterId);
    if (link === null) {
      throw new NotInCastError(seriesId, characterId);
    }
    const next: SeriesCastLink = { ...link, effectiveUntil: until };
    validateCastLink(next);
    await this.castStore.update(seriesId, characterId, {
      effectiveUntil: until,
    });
  }

  /** Updates mutable link fields (status, range, series overrides). */
  async updateCastLink(
    seriesId: string,
    characterId: string,
    patch: Omit<Parameters<SeriesCastStore["update"]>[2], never>,
  ): Promise<void> {
    const link = await this.castStore.get(seriesId, characterId);
    if (link === null) {
      throw new NotInCastError(seriesId, characterId);
    }
    const next: SeriesCastLink = { ...link, ...patch };
    validateCastLink(next);
    await this.castStore.update(seriesId, characterId, patch);
  }

  /** Returns one resolved member, or null when not covering the episode. */
  async resolveMember(
    seriesId: string,
    characterId: string,
    point: EpisodePoint,
  ): Promise<ResolvedCastMember | null> {
    const members = await this.resolveCastForEpisode(seriesId, point);
    return members.find((m) => m.characterId === characterId) ?? null;
  }

  /** Exposed for callers that need the canon-at-time global record. */
  async getGlobalRecord(
    characterId: string,
  ): Promise<GlobalCharacterRecord | null> {
    return this.globalCharacters.get(characterId);
  }
}