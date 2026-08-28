/**
 * AGN-008 — barrel: Agnes first/last/reference pre-flight validation.
 *
 * The Agnes video adapter (AGN-004 submit layer) composes an
 * {@link AgnesVideoRequestShape} from the shot plan, resolves the model's
 * {@link AgnesValidationProfile}, calls {@link validateAgnesRequest} (or the
 * throwing {@link assertAgnesRequest}) BEFORE any provider call, and only on
 * `ok` maps the shape to the exact payload with {@link buildAgnesVideoPayload}.
 */
export {
  AGNES_VIDEO_2_5_FLASH_VALIDATION_PROFILE,
  AGNES_VIDEO_2_5_VALIDATION_PROFILE,
  AGNES_VIDEO_VALIDATION_PROFILES,
  fieldsToMode,
  getAgnesValidationProfile,
} from "./profiles.js";
export {
  validateAgnesRequest,
  assertAgnesRequest,
  AgnesRequestValidationError,
  hasAnyMediaField,
  effectiveMode,
} from "./validate.js";
export {
  buildAgnesVideoPayload,
  type AgnesApiReferenceVideo,
  type AgnesVideoApiRequest,
} from "./build.js";
export type {
  AgnesReferenceVideo,
  AgnesValidationIssue,
  AgnesValidationIssueCode,
  AgnesValidationProfile,
  AgnesValidationResult,
  AgnesVideoMode,
  AgnesVideoRequestShape,
} from "./types.js";
