/**
 * Ports the cast layer depends on (docs/ARCHITECTURE.md — feature packages
 * consume `domain` types and `core` interfaces; global-library storage is a
 * port here so cast never imports adapter packages).
 */

import type {
  EpisodePoint,
  GlobalCharacterRecord,
  SeriesCastLink,
  SeriesCastLinkPatch,
} from "./types.js";

/** Thrown when a character ID does not exist in the global library. */
export class UnknownCharacterError extends Error {
  constructor(characterId: string) {
    super(`Unknown global character: ${characterId}`);
    this.name = "UnknownCharacterError";
  }
}

/** Thrown when a character is not (or no longer) part of a series cast. */
export class NotInCastError extends Error {
  constructor(seriesId: string, characterId: string) {
    super(`Character ${characterId} is not in the cast of series ${seriesId}`);
    this.name = "NotInCastError";
  }
}

/**
 * Read side of the Global Character Library. Cast links join BY ID into this
 * library; nothing here can create or delete a global character, so removing
 * a cast link can never delete the global record.
 */
export interface GlobalCharacterReader {
  /** Returns the global record or null when the ID is unknown. */
  get(characterId: string): Promise<GlobalCharacterRecord | null>;
}

/** Durable store for per-series cast links. */
export interface SeriesCastStore {
  listBySeries(seriesId: string): Promise<SeriesCastLink[]>;
  get(seriesId: string, characterId: string): Promise<SeriesCastLink | null>;
  add(link: SeriesCastLink): Promise<void>;
  /** Replaces the mutable fields of an existing link. */
  update(
    seriesId: string,
    characterId: string,
    patch: SeriesCastLinkPatch,
  ): Promise<void>;
  /**
   * Removes the LINK only. Implementations must not touch the global
   * character library — the cast layer's contract (spec.md §9).
   */
  remove(seriesId: string, characterId: string): Promise<void>;
}