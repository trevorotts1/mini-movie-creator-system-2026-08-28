# GoHighLevel (GHL) Setup — Durable Media Archive

GHL Media Storage is the V1 **durable archive** for everything MMCS
generates. Temporary provider URLs are never canonical storage — the engine
archives to GHL immediately after every generation, then treats the provider
result as safely persisted only after the archived GHL URL verifies.

- Adapter: `packages/media-storage/src/ghl/` (auth, folders, upload-hosted,
  upload-binary, tree, list, retry, validation) behind the generic
  `MediaStore` abstraction (spec §17).
- Capability/endpoint reference with provenance:
  `docs/provider-capabilities/ghl.md` (official HighLevel API v3 docs,
  verified 2026-08-28).

## Credentials

In `.env` at the repo root (names only; `.env` is gitignored):

```
GHL_ACCESS_TOKEN=   # sub-account access token or private integration token
GHL_LOCATION_ID=    # sub-account location id the archive scopes to
```

Auth is `Authorization: Bearer <token>` with the `Version: v3` header. The
token requires Media Storage read/write permissions. The token is never
logged, never echoed, never committed — the adapter's
`packages/media-storage/src/ghl/auth.ts` module redacts it by design.

## What the engine does with them

Folder tree, created **idempotently** (search before create — never duplicate
roots):

```text
Convert and Flow/
  Character Library/<Character Name>/ (Identity Masters, Expressions,
      Wardrobe, Voice References, Approved Scene References)
  Series/<Series Name>/Series Bible/ (Characters, Locations, Wardrobe, Props)
  Series/<Series Name>/Season 01/S01E01 - <Episode Title>/
      01 Script/ 02 Characters/ 03 Scene Masters/ 04 Storyboards/ 05 Audio/
      06 Video Clips/ 07 Rough Cut/ 08 Final/ 09 QC Metadata/
  Standalone Movies/<Project Name>/ (same 01–09 subfolders)
```

Archive sequence per generated asset (spec §17):

1. Find the tree root with `GET /medias/files` (location context) — search
   `Convert and Flow` before creating.
2. Create any missing folder via `POST /medias/folder`; persist the folder ID.
3. `POST /medias/upload-file` multipart with `hosted=true` +
   `fileUrl=<temporary provider URL>` + a deterministic canonical filename →
   store the returned fileId + URL → verify the GHL URL is reachable → mark
   **ARCHIVED**.
4. Fallback on remote-ingest failure: download → checksum → ffprobe/decode
   verify → binary upload (25 MB general / 500 MB video limits) → integrity
   compare → ARCHIVED only after success.
5. If archival fails, the engine **never regenerates expensive media** — the
   original provider task/job ID stays persisted and the archive sequence can
   be retried. Emergency archival (temporary URL about to expire) is tested
   end-to-end in `scripts/release/e2e-dry-run.sh` (scenario S11–S14:
   `ARCHIVED` + `BLOCKED(EXPIRED_URL)` states) — see
   `docs/e2e-dry-run-report.md`.

## Verify without spending

```bash
mmcs doctor                    # shows whether the two GHL names resolve
mmcs storage status            # archive/storage posture
mmcs providers verify          # configured vs documented capability, no paid call
```

Missing `GHL_ACCESS_TOKEN`/`GHL_LOCATION_ID` blocks the archive path
deliberately (fail closed); generation planning still runs, but nothing is
treated as persisted.