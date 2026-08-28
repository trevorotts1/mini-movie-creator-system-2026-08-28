---
name: mmcs-watchdog
description: MMCS ten-minute watchdog loop (runbook §7.1/§11, spec.md §28 "Ten-minute loops" — watchdog half) — acquire state/locks/watchdog.lock, verify recorded vs actual workflows/agents/worktrees, enforce 10 agents per workflow and 500 global, refill underfilled capacity IMMEDIATELY via visible dispatch (never merely report), ping stalled agents, kill duplicate task owners, ensure every BUILDER_DONE task has active Sonnet QC, push PASS tasks to the merge queue, update build-status.md + ledger + atomic checkpoint. Use when the watchdog loop fires (/loop 10m /mmcs-watchdog), when the user asks to "run the watchdog", "check capacity", "refill idle workers", or to preview with --dry-run / --selftest.
---

# mmcs-watchdog — ten-minute watchdog cycle

One cycle = runbook §7.1 steps 1–25, in order. The engine is
`scripts/orchestration/watchdog.ts` (CLI: `scripts/orchestration/watchdog.cli.ts`).
Run everything from the repo root. Visible work only — you never hide work or
invent concurrency; every dispatch you make is a visible workflow/agent launch.

## Fast path (preferred)

```bash
# Acceptance selftest: artificially underfilled workflow detected + refilled.
npx tsx scripts/orchestration/watchdog.cli.ts --selftest

# Preview only — computes the full detect/refill plan; mutates nothing.
npx tsx scripts/orchestration/watchdog.cli.ts --dry-run

# Real cycle: lock → detect → refill → ping/kill → QC/queue push → control state.
npx tsx scripts/orchestration/watchdog.cli.ts
```

## What the engine enforces (do not bypass, do not hand-replicate)

1. **Lock** `state/locks/watchdog.lock` (exclusive, stale locks broken after 15
   min; a live second cycle exits with the lock untouched).
2. **Sources**: `state/tasks.json`, `state/workflows.json`, `state/agents.json`,
   `state/merge-queue.json`, `state/checkpoint.json`, plus
   `state/task-updates/<ID>.builder.json` / `.qc.json` evidence.
3. **Actual vs recorded**: live workflows/agents enumerated through the
   runtime adapter; git worktrees and branches through `RealGitAdapter`
   (`git worktree list --porcelain`, `git branch --format=%(refname:short) -a`).
4. **Limits**: any workflow over 10 agents → `fail` violation; global active
   agents over 500 → `fail` violation. Never silently exceeded.
5. **Refill IMMEDIATELY** (never merely report): underfilled workflows
   (live agents < 10) with READY tasks whose dependencies are satisfied get a
   concrete refill plan — workflow id, slots, task ids — and the skill
   dispatches it through a visible workflow launch. A workflow at 0 agents with
   nothing READY is not "refilled" with idle agents — that is wasted capacity.
6. **Stalled agents**: no activity evidence within `agentStaleMs` (30 min) →
   ping (and the report names them for reassignment). Nothing is silently
   declared dead without a ping attempt.
7. **Duplicates**: one task id owned by 2+ live agents → keep the newest, kill
   the rest. Never leave a duplicate owner running.
8. **QC coverage**: every `BUILDER_DONE` task must have a
   `state/task-updates/<ID>.qc.json` with `phase: "PASS"` +
   `finalTestResult: "PASS"`; missing → dispatch Sonnet QC immediately.
9. **QC_FIXING** without documented FAIL evidence → flagged.
10. **PASS → merge queue**: every `PASS` task not already in
    `state/merge-queue.json` is pushed (via the queue adapter); a failed push
    is a `PASS_NOT_QUEUED` violation.
11. **Blocked tasks** without a documented external dependency + next action in
    the builder update → `BLOCKED_INCOMPLETE` violation.
12. **Worktrees** recorded on tasks but absent live → `WORKTREE_MISSING` info
    (recovery material), never silently assumed present.
13. **Persistence** (real cycle only): build-status.md regenerated from real
    counts, ledger append `timestamp | WATCHDOG | watchdog | CYCLE | <id> | ...`,
    checkpoint `lastWatchdogAt` updated atomically (temp + rename).
14. **Selftest** (`--selftest`): fixture state in a temp dir, one underfilled
    workflow (1/10) with 3 READY tasks, asserts the refill plan is detected and
    flagged; exits 1 on detection failure, and by construction must NOT take
    the lock, dispatch, or write any control file (mutates nothing).

## Reading the cycle report

The engine prints a JSON summary: `recorded` vs `actual` counts, `overCap`,
`underCapacity` (the refill plan), `refilled` (what was dispatched), `stalled`,
`qcGaps`, `queuePushes`, `violations` with severities, and `needsAttention`.
`needsAttention` is true when any `warn` or `fail` violation, refill entry,
stalled agent, or "no Sonnet" QC gap exists — that is the signal to act, not
just to read.

## Notes

- Never hand-edit control files while a cycle holds the lock; the second cycle
  exits cleanly and the first cycle's plan is the one that executes.
- Refill dispatch goes through the same visible workflow mechanism the
  orchestrator uses for every other launch — no hidden swarms.
- `--dry-run` never writes: no dispatch, no queue push, no
  ledger/checkpoint/build-status mutation. It still takes and releases the
  watchdog lock (a concurrent real cycle must be blocked during the read), so
  it can exit with `lockAcquired: false` if a live cycle holds the lock.
- `--selftest` never writes: no lock, no dispatch, no queue push, no
  ledger/checkpoint/build-status mutation (fixture state in a temp dir).
  Safe to run any time.
