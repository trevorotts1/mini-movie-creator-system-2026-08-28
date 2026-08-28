export {
  nextCharacterId,
  nextCharacterIdForSlug,
  sameCharacterId,
  slugifyCharacterName,
  type CharacterIdRequest,
} from "./ids/allocate.js";
export {
  CHARACTER_ID_MAX_SEQUENCE,
  CHARACTER_ID_MIN_SEQUENCE,
  CHARACTER_ID_PATTERN,
  CHARACTER_ID_PREFIX,
  CharacterIdError,
  formatCharacterId,
  isCanonicalSlug,
  isValidCharacterId,
  padSequence,
  parseCharacterId,
  type CharacterIdParts,
} from "./ids/ids.js";

export * from "./wardrobe/index.js";

export const MMCS_CHARACTER_LIBRARY = "@mmcs/character-library scaffold marker";

export type {
  CastStatus,
  CharacterAssetState,
  GlobalCharacterRecord,
  ResolvedCastMember,
  SeriesCastLink,
  SeriesCastLinkPatch,
} from "./cast/index.js";
export {
  isCastableState,
  linkCoversEpisode,
  DuplicateCastLinkError,
  NotInCastError,
  UnknownCharacterError,
  type GlobalCharacterReader,
  type SeriesCastStore,
  InvalidCastRangeError,
  InvalidCharacterIdError,
  isValidPermanentCharacterId,
  validateCastLink,
  CastService,
  type LinkCharacterInput,
  InMemoryGlobalCharacterReader,
  InMemorySeriesCastStore,
} from "./cast/index.js";

export * from "./locations/index.js";
export { isAtOrAfter } from "./wardrobe/index.js";
