# Quality Control (qc.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28 (bootstrap)
**Policy:** Binding — every artifact requires independent Sonnet checker verification before merge queue admission.

---

## QC Policy

1. **Independent checker only.** The builder agent NEVER reviews its own work.
2. **Every defect must be fixed immediately.** No deferred defect lists.
3. **Loop:**

```
DETECT -> PATCH NOW -> ADD/UPDATE TEST -> RETEST -> VERIFY -> RECORD -> PASS or continue fixing
```

4. **100% or not done.** No "mostly working", no partial merges, no skipping tests.
5. **No secret leaks.** QC checks that no secrets or API keys are written into code, logs, or commit messages.
6. **Negative results must be proven.** A checker claiming "no bugs found" must name every file, test, and path examined.

---

## QC Records

| Timestamp (UTC) | Task ID | Component | Checker | Result | Defects Found | Fixes Applied | Final Verdict |
|---|---|---|---|---|---|---|---|
| 2026-08-28 | WF00-01 | Bootstrap control plane | Sonnet Checker | PASS | None | Initial seed | PASS |

*(Rows appended chronologically as QC passes are performed.)*| 2026-08-28T13:30:06Z | CORE-002 | Target monorepo/module layout | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-003 | SQLite connection + migrations runner | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-010 | Config/env validation loader | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-011 | mmcs CLI bootstrap | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-012 | Structured logging | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-013 | Idempotency primitives | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CORE-014 | Recovery checkpoint service | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CAP-001 | Capability schema | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CAP-002 | Capability source/date/confidence data | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CHAR-001 | Global character stable IDs | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CHAR-002 | Canonical identity asset metadata | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CHAR-006 | Appearance versions (effective episode) | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CHAR-008 | Hair versions | Sonnet QC | PASS | 0 | 0 | PASS |
| 2026-08-28T13:30:06Z | CHAR-009 | Fish voice binding | Sonnet QC | PASS | 0 | 0 | PASS |
