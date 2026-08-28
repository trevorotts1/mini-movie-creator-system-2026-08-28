/** Stable business character ID, e.g. "CHAR_MONICA_BENNETT_001" (spec §9). */
export type CharacterId = string;

/** Version identifier for a hair state, e.g. "HAIR_MONICA_BENNETT_001_V2". */
export type HairVersionId = string;

/** Series continuity point. Season/episode are 1-based. */
export interface EpisodeRef {
  readonly season: number;
  readonly episode: number;
}