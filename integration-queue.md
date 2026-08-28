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
| IQ-004 | CAP-007 | task/TASK-CAP-007-llm-registry | CAP | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-005 | CAP-009 | task/TASK-CAP-009-providers-verify | CAP | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-006 | CAP-010 | task/TASK-CAP-010-observed-overrides | CAP | Sonnet | PASS | `integration` | CONFLICT_REBASE | Pending |
| IQ-008 | KIE-001 | task/TASK-KIE-001-kie-client | KIE | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-009 | CORE-005 | task/CORE-005-character-schema | CORE | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-010 | CORE-006 | task/CORE-006-scene-shot-schema | CORE | Sonnet | PASS | `integration` | CONFLICT_REBASE | Pending |
| IQ-011 | CORE-007 | task/CORE-007-job-asset-schema | CORE | Sonnet | PASS | `integration` | CONFLICT_REBASE | Pending |
| IQ-012 | CHAR-011 | task/CHAR-011-location-library | CHAR | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-013 | GHL-003 | task/TASK-GHL-003-ghl-folder | GHL | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-014 | KIE-005 | task/TASK-KIE-005-wan-profile | KIE | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-015 | VID-001 | task/VID-001-preserve-upstream-kits | VID | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-016 | GHL-004 | task/TASK-GHL-004-ghl-tree | GHL | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-017 | KIE-006 | task/TASK-KIE-006-wan-validation | KIE | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-018 | KIE-010 | task/TASK-KIE-010-kie-contract | KIE | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-019 | GHL-005 | task/TASK-GHL-005-ghl-hosted | GHL | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-020 | GHL-006 | task/TASK-GHL-006-ghl-binary | GHL | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
| IQ-021 | GHL-011 | task/TASK-GHL-011-ghl-retry | GHL | Sonnet | PASS | `integration` | QC_FIXING_ROLLED_BACK | Pending |
*(Batch merger agent processes admitted rows sequentially, executes git merge, tests on target branch, and updates `state/checkpoint.json`.)*
