# Build Status Dashboard (build-status.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28T15:26:14Z
**Current Stage:** Wave-1 Batch Merge 4 Rolled Back

---

## 1. Task State Summary

| Metric | Count |
|---|---|
| Total Tasks | 149 |
| Ready Tasks | 114 |
| Blocked Tasks | 0 |
| Building Tasks | 0 |
| QC Tasks | 0 |
| QC-fixing Tasks | 0 |
| Merge Queue Tasks | 0 |
| Merged Tasks | 35 |
| Verified Tasks | 43 |

---

## 2. Integration & Checkpoint State

| Metric | Value |
|---|---|
| Last Batch Merge Timestamp | 2026-08-28T15:26:14Z |
| Current Integration Commit | `5cb2c2e` (== origin/integration, unchanged) |
| Batch 1 Merged Count | 14 |
| Batch 2 Merged Count | 5 (CAP-005, CAP-006, CAP-008, KIE-002, KIE-003) |
| Batch 3 Merged Count | 16 (CAP-004, CHAR-007, CORE-001, CORE-004, FISH-001, GHL-001, KIE-004, KIE-009, CHAR-003, CHAR-010, CHAR-012, FISH-002, GHL-002, GHL-007, CHAR-004, FISH-004) |
| Batch 3 Conflict-Blocked QC PASS | 8 (CAP-007, CAP-009, CORE-005, CORE-006, CORE-007, KIE-001, CAP-010, CHAR-011) |
| Batch 1 Regression Status | PASS (287/287 tests) |
| Batch 2 Regression Status | PASS (408/408 tests, 24 files) |
| Batch 3 Regression Status | PASS (all package tests passing, 0 typecheck errors across all 17 workspace packages) |

| Batch 4 Merged Locally | 14 (CAP-007, CAP-009, CORE-005, GHL-003, KIE-001, KIE-005, VID-001, CHAR-011, GHL-004, KIE-006, KIE-010, GHL-005, GHL-006, GHL-011) — ALL ROLLED BACK |
| Batch 4 Conflict-Blocked | 3 (CORE-006, CORE-007, CAP-010) |
| Batch 4 Regression Status | FAIL — tests PASS (61 files / 1193 tests / 1 skipped) but typecheck FAIL: apps/cli TS6059 x ~12 from CAP-009 providers-verify import of @mmcs/capability-registry (sources outside rootDir `src`). Integration restored to 5cb2c2e; nothing pushed. |
