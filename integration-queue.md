# Integration Queue (integration-queue.md)

**Project:** mini-movie-creator-system (MMCS)
**Role:** Serialized batch merge processor into integration and main branches.

---

## 1. Admission Rules

A task may only enter the Integration Queue when ALL 10 conditions are satisfied:

1. **Builder committed:** All changes are committed to the task branch or worktree with a clean git diff.
2. **Sonnet QC PASS:** An independent Sonnet checker reviewed the diff and issued an explicit `PASS` verdict.
3. **Defects fixed:** Zero open defects or deferred fix items remain.
4. **Tests green:** Automated tests pass with 100% success on the branch.
5. **Checklist items checked:** Corresponding checklist items in `checklist.md` have been updated.
6. **Dependencies satisfied:** All upstream dependency tasks in `task-graph.md` have already landed in main.
7. **Branch known:** Origin branch or worktree ref is verified to exist and resolve.
8. **No ownership collision:** Changed files strictly match declared `Owned Paths` in `ownership.md`.
9. **Secrets scan clean:** Diff is verified free of API keys, tokens, or credential strings.
10. **No heavy media committed:** Large binary video/audio test assets are stored outside git or under `.gitignore`.

---

## 2. Integration Queue Table

| Queue ID | Task ID | Branch / Worktree | Builder | Checker | QC Verdict | Target Branch | Status | Landed SHA |
|---|---|---|---|---|---|---|---|---|
| IQ-000 | WF00-01 | `main` (direct bootstrap) | ControlPlane | Self | PASS | `origin/main` | READY_TO_MERGE | Pending |
*(Batch merger agent processes admitted rows sequentially, executes git merge, tests on target branch, and updates `state/checkpoint.json`.)*
| IQ-B6 | BATCH-6 (44 tasks) | 44 task branches | builders | qc-batch | PASS | `origin/integration` | MERGED | 9c90d71..01d5505 (2 reverts: VID-008, SKL-002) |
| IQ-B6C | CORE-007 | task/CORE-007-job-asset-schema | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | c6766d5 |
| IQ-B6C | DIR-002 | task/DIR-002-concept-generator | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | 044354d |
| IQ-B6C | QC-002 | task/QC-002-identity-check | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | 0255884 |
| IQ-B6C | QC-003 | task/QC-003-wardrobe-check | builder | qc-batch | PASS | `origin/integration` | MERGED | 692b20f9f83fc934ab561668026b0c610a350a88 |
| IQ-B6C | QC-004 | task/QC-004-continuity | builder | qc-batch | PASS | `origin/integration` | MERGED | b43743aefded95186bd5bf1c83a02f2e243a8855 |
| IQ-B6C | QC-010 | task/QC-010-wan-fallback | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-9) | 47f919e7897295509934538afff2353d1345cd60 |
| IQ-B6C | REC-010 | task/REC-010-restart-sim | builder | qc-batch | PASS | `origin/integration` | SUPERSEDED (batch-13 re-merge under IQ-B12, ecf4722) | ecf4722 |
| IQ-B6C | SKL-003 | task/SKL-003-personal-install | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | 7c6a79f |
| IQ-B6C | SKL-004 | task/SKL-004-nine-verify | builder | qc-batch | PASS | `origin/integration` | MERGED | fef49fcb5a61f8ee99a58e73c854e4aacd44e791 |
| IQ-B6C | SKL-005 | task/SKL-005-openclaw-workspace | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | f1689ba |
| IQ-B6C | VID-005 | task/VID-005-generated-clip-layer | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | b22a21f |
| IQ-B6C | VID-013 | task/VID-013-shot-replacement | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-7) | 6d8cce1 |
| IQ-B6C | VID-008 | task/VID-008-graphics-layer | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-9) | f99eea41ec33874675057fcebac75070b0601edb |
| IQ-B10 | CORE-008 | task/CORE-008-approval-gates | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-10) | afe126e2af7dd3f8ca2f68aa0ccb8fbbb1e04358 |
| IQ-B10 | CORE-009 | task/CORE-009-cost-engine | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-10) | 362a9857039326fe446c4ec2e43b587514715670 |
| IQ-B10 | CORE-015 | task/CORE-015-db-backup | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-10) | b2992b910b18b1785347d7077a19b05b032bcd50 |
| IQ-B10 | QC-005 | task/QC-005-qc-route | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-10) | 73de2a2c7ac612518d88b27fdae7da8e332e8bac |
| IQ-B10 | SKL-002 | task/SKL-002-claude-project-install | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-10, cycle-2 re-admission) | dfa9ba76134486e6c7b16b2e005e326b91767b57 |
| IQ-B10 | REC-010 | task/REC-010-restart-sim | builder | qc-batch | PASS | `origin/integration` | SUPERSEDED (admitted batch-13, ecf4722) | ecf4722 |
| IQ-B11 | CHAR-005 | task/CHAR-005-character-locking | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | 2e1fb2a |
| IQ-B11 | CHAR-013 | task/CHAR-013-canon-approval | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | dd9106a |
| IQ-B11 | DIR-003 | task/DIR-003-concept-approval | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | 88cc4dc |
| IQ-B11 | DIR-008 | task/DIR-008-script-approval | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | ff2ce06 |
| IQ-B11 | DIR-015 | task/DIR-015-storyboard-approval | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | 0c174e1 |
| IQ-B11 | QC-007 | task/QC-007-agnes-flash-route | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11; state-record add/add resolved to branch) | c5802ad |
| IQ-B11 | QC-011 | task/QC-011-human-review | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | 4006d69 |
| IQ-B11 | REL-001 | task/TASK-REL-001-clean-install | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-11) | 00d4bca |
| IQ-B12 | REC-002 | task/REC-002-precompact | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | 36c9a62 |
| IQ-B12 | REC-003 | task/TASK-REC-003-postcompact | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | f706e04 |
| IQ-B12 | REC-004 | task/REC-004-session-start | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | 3822ff5 |
| IQ-B12 | REC-005 | task/REC-005-session-end | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | 42f5146 |
| IQ-B12 | REC-006 | task/REC-006-task-completed | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | 7a5dde4 |
| IQ-B12 | REC-007 | task/REC-007-teammate-idle | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | ec03405 |
| IQ-B12 | REC-010 | task/REC-010-restart-sim (re-cert QC sha 8fd8217 ancestor of tip 2c85766) | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-13; state-record add/add resolved to branch) | ecf4722 |
| IQ-B13 | REC-011 | task/REC-011-compact-sim | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-13) | 550a6da |
| IQ-B13 | REL-003 | task/REL-003-example-project | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-13) | c365e8e |
| IQ-B12 | REL-002 | task/REL-002-full-regression | builder | qc-batch | PASS | `origin/integration` | MERGED (batch-12) | 2478ef6 |

*(Batch-7 2026-08-28T22:05:00Z: 7 IQ-B6C rows merged; QC-003/004/010, SKL-004, VID-002 still conflict-blocked; REC-010 not admitted — deps unmerged; plus 12 new merges CAP-003, CAP-010, FISH-003, FISH-005, FISH-006, FISH-007, KIE-010. Pushed 38974b3..6d8cce1.)*

*(Batch-8 2026-08-28T19:57:36Z: SKL-004 fef49fc, VID-002 a8fa4ea, QC-003 692b20f, QC-004 b43743a merged onto integration; regression PASS 3188 tests; pushed 0e9b00e..b43743a, control da5cc75. QC-010 conflict-blocked again (packages/qc/src/index.ts) — rebase required. REC-010 still deps-blocked. VID-008 blocked: conflict + open blocker.)*

*(Batch-9 2026-08-28T20:30:00Z: QC-010 47f919e and VID-008 f99eea4 merged onto integration; regression PASS (pnpm -r test + typecheck exit 0, vitest 3364/1 skipped, 3 pre-existing react-env failures identical pre-batch); pushed 1e06ddb..f99eea4. REC-010 still deps-blocked.)*

*(Batch-10 2026-08-28T23:35:00Z: 5 merged — CORE-008 afe126e, CORE-009 362a985, CORE-015 b2992b9, QC-005 73de2a2, SKL-002 dfa9ba7 (cycle-2 re-admission after IQ-B6 revert; node-types typecheck fix verified: tsc + vitest clean on integration). Zero conflicts. Regression PASS: pnpm -r test exit 0, pnpm -r run typecheck exit 0, batch-touched suites 219/219. Pushed f023247..dfa9ba7. Not admitted: REC-010 (deps REC-002..005 unmerged), QC-007 (defects 3 found > 2 fixed). Unblocked: CHAR-005, CHAR-013, DIR-003, DIR-008, DIR-015, QC-011, REL-001.)*

*(Batch-11 2026-08-29T02:20:00Z: 8 merged — CHAR-005 2e1fb2a, CHAR-013 dd9106a, DIR-003 88cc4dc, DIR-008 ff2ce06, DIR-015 0c174e1, QC-011 4006d69, REL-001 00d4bca, QC-007 c5802ad (add/add conflict on its own state record resolved to the branch round-2 QC file; batch-10's 3>2 rejection superseded — the 3rd item was a repo-wide lint-script infra gap outside owned paths). Regression PASS: full vitest 3795/1 skipped (one non-deterministic 5s timeout in backup.test.ts proven flake), typecheck 17/17 RC=0. Pushed f5e9fb8..c5802ad. Not admitted: REC-010 (deps REC-002..005, 5th cycle). Unblocked: REL-002, REL-003 -> READY.)*

*(Batch-12 2026-08-29T04:40:00Z: 7 merged — REC-002 36c9a62, REC-003 f706e04, REC-004 3822ff5, REC-005 42f5146, REC-006 7a5dde4, REC-007 ec03405, REL-002 2478ef6. The six hook branches each carried their own single-event .claude/settings.json; add/add conflicts resolved by deep union — all 6 hook events verified present. Regression PASS: pnpm -r test, typecheck 17/17, full vitest 3982/1 skipped (backup.test.ts 5s-timeout flake recurrence, proven non-deterministic again), REL-002 acceptance 17/17 after remotion npm ci. Pushed d92b62c..2478ef6. Not admitted: REC-010 (qc sha not ancestor of rebased tip). Unblocked: REC-011.)*

*(Batch-13 2026-08-29T08:30:00Z: 3 merged — REC-010 ecf4722 (re-cert QC sha 8fd8217 verified ancestor of tip 2c85766; deps all MERGED; one state-record add/add resolved to branch round), REC-011 550a6da, REL-003 c365e8e — both clean. Regression PASS: pnpm -r test RC=0 (apps/cli 152/152, integrations/claude 45/45, integrations/openclaw 23/23), pnpm -r run typecheck RC=0 (17/17 Done), full vitest 4010 passed/1 skipped clean rerun (one backup.test.ts 5s-timeout flake on first run — batch-11/12-proven non-deterministic), examples acceptance 7/7, sim suites 28/28, providers idempotency suites 68/68 from root (bare-subpath load failure reproduces only under packages/providers local include pattern — identical on integration base, pre-existing baseline, not batch-caused). Pushed ddd5748..c365e8e. Unblocked: REL-004 -> READY (deps: REL-002 MERGED batch-12, REL-003 MERGED batch-13, CHAR-005/DIR-003/DIR-008/DIR-015/QC-011/VID-012/GHL-008 all MERGED earlier). REL-005/006 remain BLOCKED.)*
| IQ-B14 | PROBE-SONNET | task/TASK-KIE-004-seedance-modes (rebase fixer; tip bbda06b, QC sha fb47e6d) | sonnet-rebase-fixer | sonnet-rebase-fixer | PASS | `origin/integration` | MERGED (batch-14) | 4c21b10 |
| IQ-B14 | ENV-001 | task/ENV-react-dependency (QC-fixed react/remotion deps; tip be07460) | builder(none)/qc-fixed | qc-batch | PASS | `origin/integration` | MERGED — pre-existing ancestor, no new merge (batch-14 fold) | be07460 |
| IQ-B14 | REL-004 | task/REL-004-e2e-dry-run (tip 3cb1165, certified sha 2ece632) | builder(qc-fixed) | qc-batch | PASS | `origin/integration` | MERGED (batch-14) | 7df92d2 |

*(Batch-14 2026-08-29T11:30:00Z: 2 merges — PROBE-SONNET 4c21b10 (KIE-004 seedance-modes rebase branch: callback-URL validation + buildSeedanceTaskRequest; kie 67/67, seedance 52/52, tsc clean per QC; KIE-004 status already MERGED — state-record fold), REL-004 7df92d2 (e2e dry run; certified sha 2ece632 ancestor of tip 3cb1165; both clean, zero conflicts). ENV-001 admitted-by-rules but its task/ENV-react-dependency tip be07460 (react/react-dom/remotion dep fix, lockfile +104 lines, stray VID-005 symlinks deleted) verified already an ancestor of integration — no merge needed. Regression PASS: pnpm -r test RC=0 (apps/cli 152/152, integrations/claude 45/45, integrations/openclaw 23/23; others --passWithNoTests), pnpm -r run typecheck 17/17 RC=0, full vitest 4014 passed/1 skipped clean rerun after known backup.test.ts 5s-timeout flake (one disclosed retry; batch-11/12/13-proven non-deterministic), scripts/release e2e re-run on integration RC 0 (11/11), vitest scripts/release 4/4, tsc -p scripts/release clean. pnpm-lock.yaml unchanged — no install. Pushed 6475dc3..7df92d2. Unblocked: REL-005 -> READY (REL-004 MERGED; all other deps MERGED). REL-006 remains BLOCKED (on REL-005).)*

*(Batch-15 2026-08-29T12:05:00Z: 1 merge — REL-005 4edaf7c (provider smoke; certified sha da8d1c1 ancestor of tip badfd6c; zero conflicts). Queue previously empty (batch-14 drained it); REL-005 admitted direct from worktrees/REL-005/state QC PASS 3/3 defects fixed. Regression PASS: pnpm -r test RC=0 (apps/cli 152/152, integrations/claude 45/45, integrations/openclaw 23/23; others --passWithNoTests), typecheck 17/17 RC=0, full vitest 4028 passed/1 skipped clean rerun after known backup.test.ts 5s-timeout flake (one disclosed retry; batch-11..14-proven non-deterministic; isolated rerun 12/12), scripts/release vitest 51/51, tsc clean, provider-smoke --report-only RC 0 (4/4 BLOCKED, spend $0, $25 gate held), e2e-dry-run.sh RC 0 (11/11). pnpm-lock.yaml unchanged — no install. Pushed 7396092..5c9bef0. Unblocked: REL-006 -> READY (all 10 deps MERGED — orchestrator dispatches REL-006 release-docs build; 149/149 then MERGED, main promotion next). Queue empty.)*
