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
export {
  nextCharacterId,
  nextCharacterIdForSlug,
  sameCharacterId,
  slugifyCharacterName,
  type CharacterIdRequest,
} from "./ids/allocate.js";

export const MMCS_CHARACTER_LIBRARY = "@mmcs/character-library scaffold marker";