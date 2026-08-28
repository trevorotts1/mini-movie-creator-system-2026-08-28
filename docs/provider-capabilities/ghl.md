# GHL (GoHighLevel) — Media Storage API capabilities

**Source:** official HighLevel developer documentation (HighLevel API Reference, version **v3**)
**Last verified:** 2026-08-28 (pages fetched live and read directly)
**Task:** GHL-001 (auth/config) — verified before coding the `GoHighLevelMediaStore` adapter.

## Auth (verified)

- Scheme: **HTTP Bearer** (`Security Scheme Type: http`, `HTTP Authorization Scheme: bearer`,
  `Bearer format: JWT`).
- Token: "Use the Access Token generated with user type as Sub-Account (OR) Private
  Integration Token of Sub-Account." Both work in the same header shape.
- Header: `Authorization: Bearer <token>` — same usage for Private Integration tokens
  ("used in the Authorization header, just like other Access Tokens").
- Required API version header: `Version: v3` (header parameter, required, option `v3`) on
  the Media Storage v3 endpoints.
- Private Integration tokens are static; rotate every ~90 days (7-day overlap window after
  rotation). OAuth access tokens expire daily.
- Rate limits (public API 2.0, per app per resource): burst 100 requests / 10 seconds,
  daily 200,000 requests. Response headers: `X-RateLimit-Limit-Daily`,
  `X-RateLimit-Daily-Remaining`, `X-RateLimit-Interval-Milliseconds`, `X-RateLimit-Max`,
  `X-RateLimit-Remaining`.

## Base URL

`https://services.leadconnectorhq.com` (per official curl examples on the Authorization
and docs-index pages).

## Endpoints (Media Storage, v3)

| Operation | Method + path | Notes |
|---|---|---|
| Get List of Files/Folders | `GET /medias/files` | Query params: `offset`, `limit`, `sortBy` (required), `sortOrder` (required), `type` (required), `query`, `altType` (required, option `location`), `altId` (required, location id), `parentId`, `fetchAll`. Response: `{ "files": [ { altId, altType, name, parentId, url, path } ] }`. |
| Upload File into Media Storage | `POST /medias/upload-file` | Header param `Version` (required, `v3`). Body `multipart/form-data`: `file` (binary), `hosted` (boolean), `fileUrl` (string), `name`, `parentId`. "If hosted is set to true then fileUrl is required. Else file is required. If adding a file, maximum allowed is 25 MB. For video files, the maximum allowed size is 500 MB." Response 200: `{ fileId, url }` — `url` is a Google Cloud Storage URL. |
| Create Folder | `POST /medias/folder` | Body JSON: `altId` (required, location id), `altType` (required, `location`), `name` (required), `parentId` (optional). Response 200: folder object (altId, altType, name, parentId, type "folder", …). |
| Delete File or Folder | DELETE (see page) | soft delete/trash variants listed under the tag page |
| Update File/Folder | — | single object by ID |
| Bulk Update Files/Folders | — | metadata/status of multiple objects |
| Bulk Delete / Trash | — | soft-delete multiple objects |

Category page: "Media Files/Folders" lists exactly these operations under the
**Media Storage** group (Introduction, Get List, Upload, Delete, Update, Create Folder,
Bulk Update, Bulk Delete).

## Size limits

- General file upload: **25 MB** maximum.
- Video file upload: **500 MB** maximum.

## Source URLs (all fetched 2026-08-28)

- Media Storage intro + auth scheme:
  https://marketplace.gohighlevel.com/docs/ghl/medias/media-storage-api
- Media Files/Folders tag page:
  https://marketplace.gohighlevel.com/docs/ghl/medias/media-files-folders
- Get List of Files/Folders (v3):
  https://marketplace.gohighlevel.com/docs/ghl/medias/fetch-media-content
- Upload File into Media Storage (v3):
  https://marketplace.gohighlevel.com/docs/ghl/medias/upload-media-content
- Create Folder (v3):
  https://marketplace.gohighlevel.com/docs/ghl/medias/create-media-folder
- Authorization overview (Private Integration Token vs OAuth 2.0):
  https://marketplace.gohighlevel.com/docs/Authorization/authorization_doc
- Private Integrations Token (header usage, rotation):
  https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken
- Rate limits:
  https://marketplace.gohighlevel.com/docs/other/rate-limits
- Docs index (base URL example):
  https://marketplace.gohighlevel.com/docs/

## Notes for the adapter

- Spec §17's known facts (auth header shape, `Version: v3`, folder create/list/upload
  paths, hosted ingestion, 25 MB / 500 MB limits) match the current official docs — no
  discrepancy found on 2026-08-28.
- The `type` and `sortBy`/`sortOrder` query params are marked **required** on
  `GET /medias/files`; the list task (GHL-002) must always send them.
- Never log the bearer token (spec §17); the auth module (`packages/media-storage/src/ghl/auth.ts`)
  redacts it in `toString`/`toJSON` and exposes `redactGhlToken` for log paths.