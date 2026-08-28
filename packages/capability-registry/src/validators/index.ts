/**
 * CAP-005 — barrel: mutually-exclusive-mode validator.
 *
 * Pure module; the router, KIE/Agnes adapters, and ReferenceBudgetPlanner
 * consume these exports.
 */
export {
  EXCLUSIVE_MODE_KEYS,
  INCOMPATIBLE_COMBINATION_SEPARATOR,
  FRAME_VS_REFERENCES_CONFLICTS,
  activeModes,
  isFrameMode,
  isReferenceMode,
  parseIncompatibleCombination,
  validateExclusiveModes,
  assertExclusiveModes,
  ExclusiveModeValidationError,
  type ExclusiveModeKey,
  type ExclusiveModeCapability,
  type ModeInputs,
  type ExclusiveModeIssue,
  type ExclusiveModeIssueCode,
} from "./exclusive-modes.js";