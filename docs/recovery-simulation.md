# Restart / Recovery Simulation (REC-010)

Acceptance evidence for spec §32 **Recovery**: stop/restart recovers the active
task map **without duplicate task creation**; worktree/branch reconciliation
matches recorded state; killing provider polling after job submission resumes by
polling the **existing** task ID — **no resubmit** (spec §18).

Owner: task REC-010 (`scripts/orchestration/restart-sim.*`). Everything below
runs against **real subsystem code** — CORE-014's `CheckpointService`
(`packages/core/src/recovery/`) and KIE-002's `KieTaskRunner`
(`packages/providers/src/kie/task/`) — in sandboxed temp directories. No
providers are contacted, nothing paid, nothing in the live repo is mutated.

## Run it

```bash
# The simulation script itself (acceptance: exits 0)
npx tsx scripts/orchestration/restart-sim.ts            # from the repo root
echo $?

# Scoped to another checkout (e.g. verifying after a clone):
npx tsx scripts/orchestration/restart-sim.ts --repo-root /path/to/repo

# The vitest suite (same scenarios, plus unit-level assertions):
npx vitest run --config scripts/orchestration/vitest.config.mts scripts/orchestration
```

Sample output (all steps green → exit code 0):

```
=== MMCS restart simulation (REC-010) ===
[PASS] active-task-map-recovery
  ok - pre-restart checkpoint save :: buckets ready=2 active=2 qc=1 blocked=1 mergeQueue=1
  ok - restarted session reloads recorded task map :: reloaded buckets: ...
  ok - re-recovery creates no duplicate task ids :: after re-recovery: ...
  ok - no duplicate ids inside any bucket :: all buckets duplicate-free
[PASS] worktree-branch-reconciliation
  ok - recorded==live reconciliation passes :: compared N recorded worktrees ...
  ok - phantom recorded worktree is detected :: missing=1 unexpected=0
  ok - branch drift on a recorded worktree is detected :: missing=1 unexpected=0
[PASS] kill-polling-resume
  ok - submission persisted providerTaskId before any poll :: state=SUBMITTED ...
  ok - polling killed after submission (createTask called exactly once) ...
  ok - resume polls existing task ID, never resubmits :: createCount=1 ...
  ok - resumed poll reaches GENERATED_TEMPORARY :: state=GENERATED_TEMPORARY ...
result: PASS (scratch: /var/folders/.../mmcs-restart-sim-XXXX)
```

Exit code: `0` when every scenario passed, `1` otherwise.

## Scenario 1 — stop/restart recovers the active task map, no duplicates

Runbook §5/§6 + spec §32. The recovery promote-step
(`recoverTaskMap`) records every task id into its checkpoint bucket via
CORE-014's `uniqueIds` set-union, then the scenario:

1. Saves the checkpoint (pre-restart durable state).
2. "Restarts" — a brand-new `CheckpointService` instance with no memory reads
   the same `state/checkpoint.json` from disk; `toResumeView()` reconstructs
   the ready/active/qc/blocked/mergeQueue buckets.
3. Re-runs the recovery step against the already-recovered map. Buckets must
   not grow: re-recording recovered ids is a set no-op (the runbook §6 rule
   "do not duplicate ACTIVE/PASS/MERGED tasks").
4. Asserts no duplicate ids inside any bucket.

## Scenario 2 — worktree/branch reconciliation matches recorded state

Runbook §6 SessionStart ("reconcile worktrees/branches vs recorded state").
`reconcileWorktrees` compares a recorded worktree/branch list against live
`git worktree list --porcelain` output (path-normalized, main checkout
excluded from "unexpected"). The scenario proves both directions:

- **Positive control** — the live worktree list recorded and reconciled
  against itself passes.
- **Discriminating power** — a phantom recorded worktree (`worktrees/REC-999`)
  and a drifted branch name on an existing worktree are each flagged as
  mismatches. A reconciliation that cannot fail is not evidence.

In the aggregate runner this runs against the real repository; per-worktree
test sandboxes use the repo that contains the test file.

## Scenario 3 — kill provider polling after submission → resume, no resubmit

Spec §18 ("Restart at SUBMITTED → resume polling the existing job; never
resubmit; never double-spend") and §32 recovery acceptance. Phases:

- **Submit**: `KieTaskRunner.ensureSubmitted` persists the provider task ID
  (`state=SUBMITTED`, `providerTaskId` recorded) **before** any poll — the
  load-bearing idempotency invariant.
- **Kill**: the poller never runs; `createTask` was called exactly once.
- **Resume**: a new runner + a fresh file-backed store over the same directory
  (disk is the only shared memory, like a real process restart) reloads the
  record. `ensureSubmitted` returns the existing SUBMITTED record untouched;
  `pollOnce` polls the **persisted** task ID. Evidence: `createCount` stays 1
  and every poll hit the persisted ID. The resumed poll loop then reaches
  `GENERATED_TEMPORARY` with result URLs — still one submission.

The runner-level guard is also asserted directly: a record without a persisted
`providerTaskId` refuses to poll (the "would resubmit" tripwire in
`KieTaskRunner.pollOnce`).

## Machine contract

| Export | Purpose |
|---|---|
| `simulateRestart(opts)` | Runs all three scenarios; `{ ok, scenarios, scratchRoot }`. |
| `simulateTaskMapRecovery(scratch, seed?)` | Scenario 1 standalone. |
| `reconcileWorktrees(repoRoot, recorded)` | Scenario 2 comparator (exported for watchdog/SessionStart reuse). |
| `simulateWorktreeReconciliation(repoRoot)` | Scenario 2 standalone. |
| `simulateKillPollingResume(scratch, taskId?)` | Scenario 3 standalone; returns step + call evidence. |
| `formatReport(result)` | Human-readable PASS/FAIL report. |
| `main(argv)` | CLI entry; returns exit code. |

CLI: `restart-sim.ts [--repo-root <path>]`.

## Where this fits

- Watchdog (REC-008) and SessionStart recovery can call
  `reconcileWorktrees`/`recoverTaskMap` instead of re-deriving reconciliation
  logic.
- REL-002 full regression includes this simulation; a failure blocks
  `buildComplete=true`.
- Companion simulation: REC-011 auto-compact (`scripts/orchestration/compact-sim.*`,
  PreCompact→PostCompact checkpoint continuity).
