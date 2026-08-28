import type { CharacterId, EpisodeRef } from "./types.js";

/** Thrown when a character has no hair version effective at the requested episode. */
export class HairVersionNotFoundError extends Error {
  constructor(characterId: CharacterId, episode: EpisodeRef) {
    super(`no hair version found for ${characterId} at S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`);
    this.name = "HairVersionNotFoundError";
  }
}