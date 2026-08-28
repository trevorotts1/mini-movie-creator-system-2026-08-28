/**
 * Central GHL endpoint/config surface for the media-storage GHL adapter.
 * Re-exports the auth module so downstream tasks (list/folders/upload) import from
 * one place. Endpoint paths live with their own task modules; only the shared
 * base/version constants live here.
 */
export {
  GHL_API_BASE_URL,
  GHL_API_VERSION,
  GHL_AUTH_HEADER,
  GHL_VERSION_HEADER,
  GHL_TOKEN_ENV_VAR,
  GHL_LOCATION_ID_ENV_VAR,
  createGhlAuthConfig,
  ghlAuthConfigFromEnv,
  redactGhlToken,
  isGhlTokenPresent,
  MissingGhlConfigError,
  InvalidGhlTokenError,
} from "./auth.js";
export type { GhlAuthConfig, GhlAuthConfigInput, GhlTokenKind } from "./auth.js";

/** Official endpoint paths (v3 docs, 2026-08-28). Owned by their task modules. */
export const GHL_ENDPOINTS = {
  listFiles: "/medias/files",
  uploadFile: "/medias/upload-file",
  createFolder: "/medias/folder",
} as const;