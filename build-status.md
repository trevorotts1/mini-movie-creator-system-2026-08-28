# Build Status Dashboard (build-status.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-29T04:40:00Z
**Current Stage:** Wave-1 Batch Merge 12 Pushed

---

## 1. Task State Summary

| Metric | Count |
|---|---|
| Total Tasks | 149 |
| Ready Tasks | 2 (REC-011, REL-003) |
| Blocked Tasks | 3 |
| Building Tasks | 0 |
| QC Tasks | 0 |
| QC-fixing Tasks | 0 |
| Merge Queue Tasks | 0 |
| Merged Tasks | 143 |
| Verified (PASS, unmerged) Tasks | 1 (REC-010 — deps all MERGED batch-12; admission held on re-cert: qc sha not ancestor of rebased tip) |

---

## 2. Integration & Checkpoint State

| Metric | Value |
|---|---|
| Last Batch Merge Timestamp | 2026-08-29T04:40:00Z |
| Current Integration Commit | `2478ef6` (pushed to origin/integration) |
| Batch 6 Merged Count | 44 |
| Batch 7 Merged Count | 14 (38974b3..6d8cce1; 5 rows over-stamped, corrected in batch-8) |
| Batch 8 Merged Count | 4 (SKL-004 fef49fc, VID-002 a8fa4ea, QC-003 692b20f, QC-004 b43743a; 0e9b00e..b43743a) |
| Batch 9 Merged Count | 2 (QC-010 47f919e, VID-008 f99eea4; 1e06ddb..f99eea4) |
| Batch 10 Merged Count | 5 (CORE-008 afe126e, CORE-009 362a985, CORE-015 b2992b9, QC-005 73de2a2, SKL-002 dfa9ba7; f023247..dfa9ba7; 0 conflicts) |
| Batch 10 Regression Status | PASS (pnpm -r test exit 0; pnpm -r run typecheck exit 0, 17/17 Done; batch-touched suites 219/219; pnpm-lock unchanged) |
| Batch 10 Not Admitted | REC-010 (deps REC-002..005 unmerged), QC-007 (defects 3 found > 2 fixed) |
| Batch 10 Unblocks | CHAR-005, CHAR-013, DIR-003, DIR-008, DIR-015, QC-011, REL-001 (BLOCKED->READY) |
| Batch 11 Merged Count | 8 (CHAR-005 2e1fb2a, CHAR-013 dd9106a, DIR-003 88cc4dc, DIR-008 ff2ce06, DIR-015 0c174e1, QC-007 c5802ad, QC-011 4006d69, REL-001 00d4bca; f5e9fb8..c5802ad; 1 state-record add/add conflict resolved to branch) |
| Batch 11 Regression Status | PASS (pnpm -r test RC=0; full vitest 3795 passed / 1 skipped after backup.test.ts 5s-timeout flake proven non-deterministic; pnpm -r run typecheck RC=0, 17/17 Done; pnpm-lock unchanged) |
| Batch 11 Not Admitted | REC-010 (deps REC-002..005 unmerged — 5th cycle) |
| Batch 11 Unblocks | REL-002, REL-003 (BLOCKED->READY) |
| Batch 12 Merged Count | 7 (REC-002 36c9a62, REC-003 f706e04, REC-004 3822ff5, REC-005 42f5146, REC-006 7a5dde4, REC-007 ec03405, REL-002 2478ef6; d92b62c..2478ef6; 6 add/add conflicts on .claude/settings.json resolved by deep hook union — all 6 events survive) |
| Batch 12 Regression Status | PASS (pnpm -r test RC=0; pnpm -r run typecheck RC=0, 17/17 Done; full vitest 3982 passed / 1 skipped clean rerun — backup.test.ts 5s-timeout flake recurrence proven non-deterministic again; REL-002 acceptance 17/17 after remotion npm ci; pnpm-lock unchanged) |
| Batch 12 Not Admitted | REC-010 (certified sha 3588299 not ancestor of rebased tip 8fd8217 — re-cert required; deps all MERGED), REL-003 (builder active, not QC'd) |
| Batch 12 Unblocks | REC-011 confirmed READY (deps REC-002/003 MERGED); REC-010 dependency hold cleared |
| Batch 6 Conflict-Blocked | 13 (CAP-001..010, CHAR-003/010, CORE-007, DIR-002, FISH-001..007/009/010, GHL-001..007/011, KIE-001..006/009/010, QC-002/003/004/007/010, REC-010, SKL-002..005, VID-001/002/005/008/013 — no mergeable branch or conflict; see ledger) |
| Batch 6 Regression Status | PASS after 2 selective reverts (pnpm -r test exit 0; pnpm -r typecheck exit 0, 17/17 Done) |
| Batch 7 Regression Status | PASS (pnpm -r test exit 0; pnpm -r typecheck exit 0; repo-wide vitest 3188 passed / 1 skipped) |
| Batch 8 Regression Status | PASS (vitest areas=ALL 3188 passed / 1 skipped; typecheck via affected-area sweep) |
| Batch 9 Regression Status | PASS (pnpm -r test exit 0; pnpm -r typecheck exit 0; repo-wide vitest 3364 passed / 1 skipped; 3 pre-existing react-env collection failures identical at pre-batch sha — not batch-induced) || Batch 13 Merged Count | 3 (REC-010 ecf4722, REC-011 550a6da, REL-003 c365e8e; ddd5748..c365e8e; 1 state-record add/add conflict resolved to branch round) |
| Batch 13 Regression Status | PASS (pnpm -r test RC=0; pnpm -r run typecheck RC=0, 17/17 Done; full vitest 4010 passed / 1 skipped clean rerun — backup.test.ts 5s-timeout flake on first run, batch-11/12-proven non-deterministic, one disclosed retry; examples acceptance 7/7; sim suites 28/28; pnpm-lock unchanged) |
| Batch 13 Baseline Notes | 2 providers test files fail to load importing '@mmcs/core/idempotency' bare subpath under packages/providers local include (agnes/retry, agnes/video/submit) — identical on integration base, no active owner; suites pass 68/68 from repo root |
| Batch 13 Unblocks | REL-004 (BLOCKED->READY — control fold only, orchestrator dispatches); REL-005/006 remain BLOCKED |
| Batch 14 Merged Count | 2 merges (PROBE-SONNET 4c21b10 — KIE-004 rebase branch fold, REL-004 7df92d2 — e2e dry run; 6475dc3..7df92d2; zero conflicts; ENV-001 verified already-ancestor of integration, no merge) |
| Batch 14 Regression Status | PASS (pnpm -r test RC=0; typecheck 17/17 RC=0; full vitest 4014 passed / 1 skipped clean rerun — backup.test.ts 5s-timeout flake first run, batch-11/12/13-proven non-deterministic, one disclosed retry; e2e-dry-run.sh RC 0 on integration; pnpm-lock unchanged) |
| Batch 14 Baseline Notes | providers bare-subpath '@mmcs/core/idempotency' local-include load failure unchanged — pre-existing, no active owner (carried from batch-13); no new baseline items |
| Batch 14 Unblocks | REL-005 (BLOCKED->READY — control fold only, orchestrator dispatches); REL-006 remains BLOCKED |
| Batch 15 Merged Count | 1 (REL-005 4edaf7c — provider smoke; 7396092..5c9bef0; zero conflicts; certified sha da8d1c1 ancestor of tip badfd6c) |
| Batch 15 Regression Status | PASS (pnpm -r test RC=0; typecheck 17/17 RC=0; full vitest 4028 passed / 1 skipped clean rerun — backup.test.ts 5s-timeout flake first run, batch-11..14-proven non-deterministic, one disclosed retry; scripts/release 51/51; tsc clean; provider-smoke RC 0 spend $0; e2e-dry-run.sh RC 0 11/11; pnpm-lock unchanged) |
| Batch 15 Unblocks | REL-006 (BLOCKED->READY — all 10 deps MERGED; 149/149 tasks MERGED after REL-006; main promotion next) |
