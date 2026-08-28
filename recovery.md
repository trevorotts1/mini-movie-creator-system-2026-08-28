# Crash Recovery & Session Resume Protocol (recovery.md)

**Project:** mini-movie-creator-system (MMCS)
**Binding:** Any agent starting, restarting, or resuming in this workspace MUST follow this exact read order before taking any action.

---

## 1. Resume Read Order

When recovering from a crash, timeout, compaction, or new session start, read these files in this exact sequence:

1. `recovery.md` (this file — instructions and invariants)
2. `state/checkpoint.json` (latest recorded project-wide checkpoint)
3. `build-status.md` (high-level dashboard of counts and state)
4. `spec.md` (subsystem requirements and current status)
5. `task-graph.md` (dependency DAG and active wave)
6. `todo.md` (per-task states and assignments)
7. `checklist.md` (verified completion items)
8. `qc.md` (latest QC loop records and defect statuses)
9. `integration-queue.md` (pending and landed batch merges)
10. `ownership.md` (path locks per active task)
11. Last 200 lines of `ledger.md` (append-only event history)
12. Last 200 lines of `session.md` (active agent roster and session state)
13. Run `git status` to inspect working tree state
14. Inspect git branches and worktrees (`git branch -a`, `git worktree list`)
15. Check active background workflows (`state/workflows.json`, `state/agents.json`)

---

## 2. Reconcile Runtime vs Disk

After completing the read order:

1. **Do NOT dispatch anything new** until runtime state is reconciled with disk state.
2. If an agent listed in `state/agents.json` is no longer alive, mark its task back to `READY` (or `QC_FIXING` if defects were pending) and log to `ledger.md`.
3. If an uncommitted change exists in a worktree, verify whether it passed QC before merging or discarding.
4. Verify `current_main_sha` in `state/checkpoint.json` matches `git rev-parse HEAD`.
5. Only after all locks in `state/locks/` are verified valid and state is consistent, resume the orchestrator loop.