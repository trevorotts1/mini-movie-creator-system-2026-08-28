export const MMCS_MEDIA_STORAGE = "@mmcs/media-storage scaffold marker";

// Real public surface (SKR-012).
//
// This file used to contain ONLY the marker line above, while 65 source files — the entire
// GHL ingest path: hosted and binary upload, folder tree, listing, retry/backoff,
// validation, the asset manifest, episode folders and emergency archival — sat in
// subdirectories reachable only through the package's `./*` subpath export. Any
// `import { archiveHostedUrl } from "@mmcs/media-storage"` therefore resolved to a module
// exporting one string, and the failure mode is a silent no-op import rather than an error.
//
// Namespaced re-exports rather than flat `export *`: the subpaths genuinely collide —
// `findFolderByName` is in both ghl/folders and ghl/list, `ROOT_FOLDER_NAME` in both
// episode-folders and ghl/tree, `MEDIA_MIME_TYPES` and `MAX_GENERAL_FILE_BYTES` in both
// ghl/upload-hosted and ghl/validation — so flat re-exports would not compile and would
// also make the collision invisible at every call site.
export * as characterLinks from "./character-links/index.js";
export * as emergencyArchival from "./emergency-archival/index.js";
export * as episodeFolders from "./episode-folders/index.js";
export * as ghlFolders from "./ghl/folders/index.js";
export * as ghlList from "./ghl/list/index.js";
export * as ghlRetry from "./ghl/retry/index.js";
export * as ghlTree from "./ghl/tree/index.js";
export * as ghlUploadBinary from "./ghl/upload-binary/index.js";
export * as ghlUploadHosted from "./ghl/upload-hosted/index.js";
export * as ghlValidation from "./ghl/validation/index.js";
export * as manifest from "./manifest/index.js";
