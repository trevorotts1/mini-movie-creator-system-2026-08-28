/**
 * GHL folder operations (GHL-003).
 *
 * Public surface: create/list/find/ensure folders against the GHL Media
 * Storage API (`POST /medias/folder`, `GET /medias/files`). Auth headers are
 * injected from GHL-001 via {@link GhlFolderConfig}; nothing here logs a token.
 */
export * from "./types";
export {
  GhlFetchTransport,
  GhlFolderApiError,
  GhlFolderResponseError,
  createFolder,
  listFolders,
  findFolderByName,
  ensureFolder,
} from "./folders";