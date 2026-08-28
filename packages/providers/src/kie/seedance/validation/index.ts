/**
 * KIE-004 — barrel: Seedance modes + pre-flight validation.
 * Pure module; the KIE-003 profile and the router consume these exports.
 */
export {
  SEEDANCE_2_MINI_MODEL,
  SEEDANCE_MODES,
  SEEDANCE_MODE_CAPABILITIES,
  SEEDANCE_ASPECT_RATIOS,
  SEEDANCE_RESOLUTIONS,
  SEEDANCE_PROMPT_MIN_CHARS,
  SEEDANCE_PROMPT_MAX_CHARS,
  SEEDANCE_DURATION_MIN_S,
  SEEDANCE_DURATION_MAX_S,
  SEEDANCE_MAX_REFERENCE_IMAGES,
  SEEDANCE_MAX_REFERENCE_VIDEOS,
  SEEDANCE_MAX_REFERENCE_AUDIOS,
  isReferenceUrl,
  validateSeedanceRequest,
  buildSeedanceInput,
  inferSeedanceMode,
  SeedanceValidationError,
  type SeedanceMode,
  type SeedanceRequest,
  type SeedanceValidationIssue,
  type SeedanceModeCapabilities,
  type SeedanceAspectRatio,
  type SeedanceResolution,
} from "./modes.js";