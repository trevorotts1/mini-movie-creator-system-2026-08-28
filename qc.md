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

*(Rows appended chronologically as QC passes are performed.)*