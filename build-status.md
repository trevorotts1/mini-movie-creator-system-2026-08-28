# Build Status Dashboard (build-status.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28T22:05:00Z
**Current Stage:** Wave-1 Batch Merge 7 Pushed

---

## 1. Task State Summary

| Metric | Count |
|---|---|
| Total Tasks | 149 |
| Ready Tasks | 18 |
| Blocked Tasks | 14 |
| Building Tasks | 0 |
| QC Tasks | 0 |
| QC-fixing Tasks | 2 |
| Merge Queue Tasks | 0 |
| Merged Tasks | 122 |
| Verified (PASS, unmerged) Tasks | 3 |

---

## 2. Integration & Checkpoint State

| Metric | Value |
|---|---|
| Last Batch Merge Timestamp | 2026-08-28T19:38:57Z |
| Current Integration Commit | `6d8cce1` (pushed to origin/integration) |
| Batch 6 Merged Count | 44 |
| Batch 7 Merged Count | 19 (38974b3..6d8cce1) |
| Batch 6 Conflict-Blocked | 13 (CAP-001..010, CHAR-003/010, CORE-007, DIR-002, FISH-001..007/009/010, GHL-001..007/011, KIE-001..006/009/010, QC-002/003/004/007/010, REC-010, SKL-002..005, VID-001/002/005/008/013 — no mergeable branch or conflict; see ledger) |
| Batch 6 Regression Status | PASS after 2 selective reverts (pnpm -r test exit 0; pnpm -r typecheck exit 0, 17/17 Done) |
| Batch 7 Regression Status | PASS (pnpm -r test exit 0; pnpm -r typecheck exit 0; repo-wide vitest 3188 passed / 1 skipped) |
