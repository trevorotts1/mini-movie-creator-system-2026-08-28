/**
 * Character schema repositories (CORE-005, spec §9): characters,
 * immutable identity-version history, canonical identity assets, and
 * append-only appearance versions.
 */
export {
  AppearanceVersionRepository,
  CharacterRepository,
  CharacterRepositoryError,
  IdentityAssetRepository,
  IdentityVersionRepository,
} from "./characters.js";
export { ASSET_APPROVAL_STATES, type AssetApprovalState } from "./asset-states.js";
export {
  CHARACTER_STATES,
  type AppearanceVersion,
  type AppearanceVersionInput,
  type Character,
  type CharacterInput,
  type CharacterPatch,
  type CharacterState,
  type IdentityAsset,
  type IdentityAssetInput,
  type IdentityAssetPatch,
  type IdentityVersion,
  type IdentityVersionInput,
} from "./types.js";