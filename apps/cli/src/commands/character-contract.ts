// CHAR-004 barrel — the two command specs this task owns, ready for the
// CORE-011 dispatcher to merge over the stubs at integration.
export {
  CHOOSE_CHARACTER_SPEC,
  APPROVE_CHARACTER_SPEC,
  makeChooseCharacterHandler,
  makeApproveCharacterHandler,
  type CharacterCommandPorts,
} from "./approve-character/commands.js";
export * from "./choose-character/contract.js";