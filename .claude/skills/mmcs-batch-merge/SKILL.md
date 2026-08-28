---
name: mmcs-batch-merge
description: MMCS ten-minute batch merge loop (runbook §7.2/§11/§23) — acquire state/locks/merge.lock, admit only Sonnet-QC-PASS queue items with passing tests and satisfied dependencies, order by dependency/conflict risk, dry-check conflicts with git merge-tree, batch-merge to integration with CAS update-ref, run affected-area regression, secret/heavy-media scan, push only when green, mark MERGED, drain the queue, write evidence + ledger. Use when the merge loop fires (/loop 10m /mmcs-batch-merge), when the user asks to "run the merge cycle", "batch merge", "drain the merge queue", or to preview with a dry run. No QC PASS = no merge — never bypass the gate.
---

# mmcs-batch-merge — ten-minute merge cycle

One cycle = runbook §7.2 steps 1–15, in order. The engine is
`scripts/orchestration/batch-merge.ts` (CLI: `scripts/orchestration/batch-merge.cli.ts`).
Run everything from the repo root. You are the dedicated merge workflow's agent —
you resolve nothing by hand: conflicts go back to visible conflict resolvers.

## Fast path (preferred)

```bash
# Preview only — computes admission, ordering, conflicts; mutates nothing.
npx tsx scripts/orchestration/batch-merge.cli.ts --dry-run

# Real cycle: lock → merge → regression → scan → push → control state.
npx tsx scripts/orchestration/batch-merge.cli.ts
```

If `tsx` is unavailable, drive the engine through the engine's own report:
read `logs/merges/*-batch-merge.json` after each cycle for evidence.

## What the engine enforces (do not bypass, do not hand-replicate)

1. **Lock** `state/locks/merge.lock` (exclusive, stale locks broken after 15
   min; a live second cycle exits with the lock untouched).
2. **Queue sources**: `state/merge-queue.json`, `integration-queue.md` rows not
   yet MERGED, and `state/tasks.json` PASS entries. MERGED rows are skipped.
3. **Admission** (per item, from `state/task-updates/<ID>.qc.json`):
   - `phase: "PASS"` from the Sonnet QC agent — anything else is `NO_QC_PASS`;
   - `finalTestResult: "PASS"` — failing tests never merge;
   - zero open defects (`defectsFound - defectsFixed > 0` → reject);
   - zero open blockers;
   - dependencies satisfied (PASS/MERGED evidence for every `dependsOn` id);
   - branch resolves and the QC commit is on that branch.
4. **Ordering**: dependency topological order; ties by fewest changed-path
   overlaps (lower conflict risk first), then task id — deterministic plan.
5. **Conflicts**: pre-checked with `git merge-tree --write-tree`; conflicted
   items are recorded as CONFLICT with the file list and left for the dedicated
   merge workflow's visible conflict resolvers. Never hand-edit inside this loop.
6. **Batch merge**: two-parent merge commits via `commit-tree` +
   `update-ref` compare-and-swap — a tip that moved mid-cycle aborts the batch
   before any damage.
7. **Affected-area regression** over the whole batch diff (package/app/script
   areas via vitest; unknown roots widen to ALL).
8. **Regression fail** → whole batch reverted to the pre-batch head, then
   single-item culprit isolation; culprits named in the report; nothing pushed.
9. **Secret + heavy-media scan** before push (key shapes, private keys,
   media extensions, >5 MB blobs). Dirty scan → batch reverted, never pushed.
10. **Push** integration only after green regression + clean scan.
11. **Control state**: tasks.json → MERGED, queue drained, integration-queue.md
    rows stamped MERGED + landed sha, checkpoint heartbeat, evidence JSON in
    `logs/merges/`, `| … | batch-merge | <status> | …` lines in `ledger.md`.

## Dry-run contract

`--dry-run` runs the full lock/queue/admission/order/conflict plan and writes
**nothing**: no refs, no control files, no evidence, no pushes. Use it to
preview a cycle or to verify the fixture queue behaves as expected.

## After a cycle

- Read the printed report (or the evidence JSON). Announce: merged ids with
  shas, rejected ids with reasons, conflicts left for resolvers, regression
  result, pushed or not.
- Rejected `NO_QC_PASS` / `FAILING_TESTS` items stay queued — that is correct
  behavior (no QC PASS = no merge), not a fault to fix here. Tell the
  watchdog/QC side which items need QC or test fixes.
- Conflicted items need rebases/resolutions by the visible conflict resolvers
  (task REC-009's engine never edits them).
- Two consecutive cycles finding nothing to merge is normal; report one line
  and stop.

## Hard rules

- Never merge an item without Sonnet QC PASS — no manual overrides, no "just
  this once", no editing qc.json.
- Never push a red regression or a dirty scan. Integration stays green.
- Never resolve conflicts inside this loop — dispatch to resolvers.
- Never touch `main` — integration only; main promotes at milestone/release
  gates after full regression (runbook §23).
- Never run two merge cycles at once — the lock rejects the second.
