# Task Tracker (todo.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28 (bootstrap)
**Status:** Initial control-plane seed

---

## State Legend

| State | Meaning |
|---|---|
| `BLOCKED` | Waiting on open dependencies |
| `READY` | Dependencies satisfied, unassigned or waiting for builder |
| `BUILDING` | Builder actively writing code |
| `QC` | Sonnet checker reviewing diff |
| `QC_FIXING` | Checker returned defects; builder actively repairing |
| `PASS` | Checker verified green |
| `MERGE_QUEUE` | Admitted to integration queue |
| `MERGED` | Landed on integration branch / main |
| `VERIFIED` | Post-merge sanity checked |

---

## Task Table

| ID | Description | Dependencies | Workflow | Builder | Checker | Status | Owned Paths | Acceptance Criteria | Merge State |
|---|---|---|---|---|---|---|---|---|---|
| *WF00-01* | *Bootstrap control plane & env docs* | *None* | *WF00* | *ControlPlane* | *Self* | *BUILDING* | `state/*`, `logs/*`, root control md files | All files written, valid JSON, single commit, pushed | *PENDING* |

*(Planning workflow will populate the full task table from task-graph.md and tasks.json.)*