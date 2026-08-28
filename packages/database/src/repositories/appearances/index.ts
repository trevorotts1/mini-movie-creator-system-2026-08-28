/**
 * Appearance-version repository module (CORE-005, spec §9). The
 * {@link AppearanceVersionRepository} lives with the character schema and
 * is re-exported here as the module entry point owned by this directory.
 */
export { AppearanceVersionRepository, CharacterRepositoryError } from "../characters/characters.js";
export type { AppearanceVersion, AppearanceVersionInput } from "../characters/types.js";