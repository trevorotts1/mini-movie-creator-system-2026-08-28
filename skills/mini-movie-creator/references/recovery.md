# MMCS Recovery Reference — restart, resume, async job safety

MMCS is resumable by design. All production state lives in durable storage —
SQLite (projects, series, episodes, characters, provider jobs, assets,
approvals, QC results, costs) plus the repo's `state/` control files
(`checkpoint.json` etc.). Nothing load-bearing lives in chat context; after a
restart the engine, not the conversation, is authoritative.

## First actions after any restart / new session

```bash
git status --short --branch
git worktree list
mmcs status      # or mmcs doctor if the CLI is freshly built
mmcs recover     # resume interrupted pipeline work safely
```

Read, in order: `recovery.md`, `session.md`, `state/checkpoint.json`,
`build-status.md`, relevant control files, ledger tail. Reconcile runtime vs
disk before acting. **Never recreate a task or regenerate media whose branch
or job record already contains completed work.**

## Provider job state machine

Every provider job is a durable record persisted **before** polling, with
request hash/idempotency identifier (where supported), provider/model,
task/job ID, request params, submission timestamp, status, poll timestamp,
result URL, archival status, retry count.

```
PLANNED → BUDGET_RESERVED → SUBMITTING → SUBMITTED → GENERATING
  → GENERATED_TEMPORARY → ARCHIVING → ARCHIVED → QC_PENDING
  → (QC_FIXING →) APPROVED | REJECTED
```

Resume rules per state:

- **Restart at SUBMITTED** → resume polling the existing job. **Never
  resubmit. Never double-spend.**
- **Restart at GENERATED_TEMPORARY** → archive the known provider URL
  immediately if still valid — never regenerate because an agent forgot; the
  URL/task ID lives in SQLite/state.
- **Archival failed** → never regenerate expensive media because archival
  failed; the original provider task/job ID is persisted and the archive
  sequence can be retried (remote ingest, then binary fallback).
- **Killed mid-poll** → resume polling; a job submitted then lost is polled,
  not resubmitted.

The canonical resume command:

```bash
mmcs recover
```

## Checkpoint layout

`state/checkpoint.json` (atomic temp+rename writes at every material task
transition, before/after compaction, before/after batch merge, before planned
restart, session end, after recovery): schemaVersion, project, repoRoot,
origin, upstream, integrationBranch, wave, task IDs by state, workflow/agent
IDs, last watchdog/merge/regression timestamps, lastKnownGoodCommit, next
actions.

Control files at repo root (`spec.md`, `todo.md`, `qc.md`, `checklist.md`,
`ledger.md`, `session.md`, `recovery.md`, `decisions.md`, `task-graph.md`,
`ownership.md`, `integration-queue.md`, `build-status.md`) plus `state/`
(`workflows.json`, `agents.json`, `tasks.json`, `dependencies.json`,
`merge-queue.json`, `costs.json`, `capabilities.json`, `recovery.json`,
`locks/`) and `logs/` (`watchdog/`, `merges/`, `qc/`, `sessions/`) are
durable alongside the DB. The database and the control files are both
durable — checkpoint state and DB state are reconciled, with the DB holding
production truth and `state/` holding orchestration state.

## What NOT to do after a crash

- Do not resubmit a SUBMITTED provider job — resume the poll.
- Do not regenerate media that is already ARCHIVED in GHL; resolve the
  canonical asset via its DB record after local cache removal.
- Do not re-run `generate` for an episode where per-shot records show
  ARCHIVED/APPROVED states; regenerate only shots whose job record says so.
- Do not mark gates approved because prior conversation said so; re-run
  `mmcs status` and check persisted gate state.
- Do not treat OpenClaw's own SQLite persistence as the source of truth —
  it is secondary resilience only.

## Simulated-recovery acceptance drills

Two drills prove resumability (spec §32):

1. **Kill provider polling after job submission → resume:** the resumed run
   polls the existing task ID; no resubmit occurs (verify the provider job
   record's submit count/retry count is unchanged).
2. **Stop/restart the process → the active task map recovers without
   duplicate task creation:** `state/checkpoint.json` + DB rows reconcile
   with `git worktree list`; no task is created twice.

## Secrets during recovery

Recovery output (logs, checkpoint dumps, `mmcs status`) must never contain
credential values. If a log line ever shows a token, treat it as a security
issue: rotate the credential and record the incident in the ledger — do not
paste the value anywhere.