# Recovery

MMCS is **resumable by design**: all production state lives in durable
storage — SQLite (projects, series, episodes, characters, provider jobs,
assets, approvals, QC results, costs) plus the repo's `state/` control files
(`state/checkpoint.json` and friends). Nothing load-bearing lives in chat
context; after a restart the **engine, not the conversation, is
authoritative**.

The canonical operator reference is
`skills/mini-movie-creator/references/recovery.md`; this page maps it to the
machine files and the drill evidence.

## First actions after any restart / new session

```bash
git status --short --branch
git worktree list
mmcs status        # or mmcs doctor if the CLI is freshly built
mmcs recover       # resume interrupted pipeline work safely
```

Then read, in order: `skills/mini-movie-creator/references/recovery.md`,
`session.md`, `state/checkpoint.json`, `build-status.md`, and the relevant
control files. Reconcile runtime vs disk **before** acting. Never recreate a
task or regenerate media whose branch or job record already contains
completed work.

## The durable checkpoint

`state/checkpoint.json` is written **atomically** (unique temp file + fsync +
rename) by `@mmcs/core` `CheckpointService`
(`packages/core/src/recovery/checkpoint.ts`) at every material task
transition, before/after compaction, before/after batch merge, before a
planned restart, and at session end. A `kill -9` at any instant leaves the
previous valid checkpoint, never a partial file. `state/checkpoint.schema.json`
documents the schema (schemaVersion 1); `state/README.md` documents cadence
and reload semantics (`CheckpointService.load()` → `toResumeView()`
reconstructs the ready/active/qc/blocked/merge-queue buckets).

`state/locks/` holds runtime-only lock files (gitignored); temp-file litter
from a crash between temp creation and rename is removed by
`CheckpointService.sweepTempFiles()`.

## Provider job safety (spec §18)

Every async provider job is a durable record persisted **before** polling:
request hash/idempotency identifier, provider/model, task/job ID, params,
timestamps, status, result URL, archival status, retry count.

```text
PLANNED → BUDGET_RESERVED → SUBMITTING → SUBMITTED → GENERATING
  → GENERATED_TEMPORARY → ARCHIVING → ARCHIVED → QC_PENDING
  → (QC_FIXING →) APPROVED | REJECTED
```

Resume rules that protect both money and media:

- **Restart at SUBMITTED** → resume polling the existing job. Never resubmit;
  never double-spend.
- **Restart at GENERATED_TEMPORARY** → archive the known provider URL
  immediately if still valid — never regenerate because an agent forgot; the
  URL/task ID lives in SQLite/state.
- **Archival failed** → never regenerate expensive media; the original
  provider task/job ID is persisted and the archive sequence is retried
  (remote ingest, then binary fallback).
- **Emergency archival** (temporary URL about to expire) and
  `BLOCKED(EXPIRED_URL)` handling are drilled in
  `scripts/release/e2e-dry-run.sh` scenarios S11–S14 — evidence:
  `docs/e2e-dry-run-report.md`.

## Recovery drills (machine-verified)

```bash
npx vitest run scripts/orchestration/restart-sim.test.ts   # stop/restart drill units
npx vitest run scripts/orchestration/compact-sim.test.ts   # /compact drill units
```

Human-readable evidence with expected outputs:
`docs/recovery-simulation.md` (three scenarios: restart recovers the active
task map without duplicates; worktree/branch reconciliation matches recorded
state; kill provider polling after submission → resume with **no resubmit**)
and `docs/compact-simulation.md` (manual `/compact` flow).

## Secrets during recovery

Env variable NAMES are discoverable (`mmcs doctor`); values are never
displayed, logged, or re-entered from transcripts. Recovery reads state — it
never needs a secret echoed.