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
| IQ-B6C | REC-010 | task/REC-010-restart-sim | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
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
| IQ-B10 | REC-010 | task/REC-010-restart-sim | builder | qc-batch | PASS | `origin/integration` | NOT_ADMITTED (deps REC-002..005 unmerged) | Pending |

*(Batch-7 2026-08-28T22:05:00Z: 7 IQ-B6C rows merged; QC-003/004/010, SKL-004, VID-002 still conflict-blocked; REC-010 not admitted — deps unmerged; plus 12 new merges CAP-003, CAP-010, FISH-003, FISH-005, FISH-006, FISH-007, KIE-010. Pushed 38974b3..6d8cce1.)*

*(Batch-8 2026-08-28T19:57:36Z: SKL-004 fef49fc, VID-002 a8fa4ea, QC-003 692b20f, QC-004 b43743a merged onto integration; regression PASS 3188 tests; pushed 0e9b00e..b43743a, control da5cc75. QC-010 conflict-blocked again (packages/qc/src/index.ts) — rebase required. REC-010 still deps-blocked. VID-008 blocked: conflict + open blocker.)*

*(Batch-9 2026-08-28T20:30:00Z: QC-010 47f919e and VID-008 f99eea4 merged onto integration; regression PASS (pnpm -r test + typecheck exit 0, vitest 3364/1 skipped, 3 pre-existing react-env failures identical pre-batch); pushed 1e06ddb..f99eea4. REC-010 still deps-blocked.)*

*(Batch-10 2026-08-28T23:35:00Z: 5 merged — CORE-008 afe126e, CORE-009 362a985, CORE-015 b2992b9, QC-005 73de2a2, SKL-002 dfa9ba7 (cycle-2 re-admission after IQ-B6 revert; node-types typecheck fix verified: tsc + vitest clean on integration). Zero conflicts. Regression PASS: pnpm -r test exit 0, pnpm -r run typecheck exit 0, batch-touched suites 219/219. Pushed f023247..dfa9ba7. Not admitted: REC-010 (deps REC-002..005 unmerged), QC-007 (defects 3 found > 2 fixed). Unblocked: CHAR-005, CHAR-013, DIR-003, DIR-008, DIR-015, QC-011, REL-001.)*
