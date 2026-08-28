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
| IQ-B6C | CORE-007 | task/CORE-007-job-asset-schema | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | DIR-002 | task/DIR-002-concept-generator | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | QC-002 | task/QC-002-identity-check | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | QC-003 | task/QC-003-wardrobe-check | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | QC-004 | task/QC-004-continuity | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | QC-010 | task/QC-010-wan-fallback | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | REC-010 | task/REC-010-restart-sim | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | SKL-003 | task/SKL-003-personal-install | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | SKL-004 | task/SKL-004-nine-verify | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | SKL-005 | task/SKL-005-openclaw-workspace | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | VID-005 | task/VID-005-generated-clip-layer | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | VID-013 | task/VID-013-shot-replacement | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
| IQ-B6C | VID-008 | task/VID-008-graphics-layer | builder | qc-batch | PASS | `origin/integration` | CONFLICT_BLOCKED (rebase required) | Pending |
