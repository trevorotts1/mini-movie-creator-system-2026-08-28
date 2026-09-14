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
   be retried. Emergency archival (temporary URL about to expire) is exercised
   in `scripts/release/e2e-dry-run.sh` (scenario S14, inside the S11–S14
   budget/submit/resume/archival group: `ARCHIVED` + `BLOCKED(EXPIRED_URL)`
   states) — see `docs/e2e-dry-run-report.md`. It runs against the runner's
   scripted GHL fake, not a live transport, exactly as that report's
   "Mocked vs live" section states.

## Verify without spending

```bash
mmcs doctor                    # REAL: reports whether each provider env name (incl. the two GHL
                              # names) resolves, and whether the approval store is reachable
mmcs storage status            # static posture line only — does NOT query GHL or archive state
mmcs providers verify          # runs, but reads an EMPTY registry loader and has ZERO probes
                              # registered: it reports "0 model(s) checked", never consults
                              # @mmcs/capability-registry, and never makes a call
```

Honesty note: of these three verbs only `mmcs doctor` does real work (it reads
env-var presence and opens the durable approval store). `mmcs storage status`
prints a fixed sentence and `mmcs providers verify` completes with an empty
registry, so **none of the three proves the GHL archive path**. All three exit 0
today; unknown verbs now exit 1, but that fix does not make these verbs do work.
The zero-spend proofs that actually exercise the archive logic are
`bash scripts/release/e2e-dry-run.sh` (S14/S15/S16, scripted GHL fakes) and
`npx vitest run packages/media-storage/src/manifest` (38 tests, green:
`MediaStore` + durable asset manifest).

Known defect in the same package, unrelated to this doc: the full
`npx vitest run packages/media-storage/src` sweep currently reports
**1 failed / 326 passed** — `packages/media-storage/src/ghl/retry/retry.test.ts`
(line 90) asserts `classifyFailure(AbortError)` is `"retry"`, while
`packages/media-storage/src/ghl/retry/errors.ts` (line 186) deliberately
returns `"stop"` for caller cancellation. The test encodes the old behaviour;
the implementation is the intended one.

Missing `GHL_ACCESS_TOKEN`/`GHL_LOCATION_ID` blocks the archive path
deliberately (fail closed); generation planning still runs, but nothing is
treated as persisted.