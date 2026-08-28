# Build Status Dashboard (build-status.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28T23:35:00Z
**Current Stage:** Wave-1 Batch Merge 10 Pushed

---

## 1. Task State Summary

| Metric | Count |
|---|---|
| Total Tasks | 149 |
| Ready Tasks | 14 |
| Blocked Tasks | 5 |
| Building Tasks | 0 |
| QC Tasks | 0 |
| QC-fixing Tasks | 0 |
| Merge Queue Tasks | 0 |
| Merged Tasks | 128 |
| Verified (PASS, unmerged) Tasks | 1 (REC-010, deps-blocked) |

---

## 2. Integration & Checkpoint State

| Metric | Value |
|---|---|
| Last Batch Merge Timestamp | 2026-08-28T23:35:00Z |
| Current Integration Commit | `dfa9ba7` (pushed to origin/integration) |
| Batch 6 Merged Count | 44 |
| Batch 7 Merged Count | 14 (38974b3..6d8cce1; 5 rows over-stamped, corrected in batch-8) |
| Batch 8 Merged Count | 4 (SKL-004 fef49fc, VID-002 a8fa4ea, QC-003 692b20f, QC-004 b43743a; 0e9b00e..b43743a) |
| Batch 9 Merged Count | 2 (QC-010 47f919e, VID-008 f99eea4; 1e06ddb..f99eea4) |
| Batch 10 Merged Count | 5 (CORE-008 afe126e, CORE-009 362a985, CORE-015 b2992b9, QC-005 73de2a2, SKL-002 dfa9ba7; f023247..dfa9ba7; 0 conflicts) |
| Batch 10 Regression Status | PASS (pnpm -r test exit 0; pnpm -r run typecheck exit 0, 17/17 Done; batch-touched suites 219/219; pnpm-lock unchanged) |
| Batch 10 Not Admitted | REC-010 (deps REC-002..005 unmerged), QC-007 (defects 3 found > 2 fixed) |
| Batch 10 Unblocks | CHAR-005, CHAR-013, DIR-003, DIR-008, DIR-015, QC-011, REL-001 (BLOCKED->READY) |
| Batch 6 Conflict-Blocked | 13 (CAP-001..010, CHAR-003/010, CORE-007, DIR-002, FISH-001..007/009/010, GHL-001..007/011, KIE-001..006/009/010, QC-002/003/004/007/010, REC-010, SKL-002..005, VID-001/002/005/008/013 — no mergeable branch or conflict; see ledger) |
| Batch 6 Regression Status | PASS after 2 selective reverts (pnpm -r test exit 0; pnpm -r typecheck exit 0, 17/17 Done) |
| Batch 7 Regression Status | PASS (pnpm -r test exit 0; pnpm -r typecheck exit 0; repo-wide vitest 3188 passed / 1 skipped) |
| Batch 8 Regression Status | PASS (vitest areas=ALL 3188 passed / 1 skipped; typecheck via affected-area sweep) |
| Batch 9 Regression Status | PASS (pnpm -r test exit 0; pnpm -r typecheck exit 0; repo-wide vitest 3364 passed / 1 skipped; 3 pre-existing react-env collection failures identical at pre-batch sha — not batch-induced) |