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
| 2026-08-28T10:05:00Z | CORE-001 | Upstream audit + preservation map | Sonnet QC | PASS | 0 | 0 | PASS (merge conflict: docs/BASELINE-REPORT.md add/add — rebasing required) |
| 2026-08-28T10:05:00Z | CAP-004 | Reference-count validator | Sonnet QC | PASS | 0 | 0 | PASS (merge conflict: capability-registry index.ts — rebasing required) |
| 2026-08-28T10:05:00Z | CAP-007 | Reasoning/vision LLM registry | Sonnet QC | PASS | 2 | 2 | PASS (merge conflict: index.ts + pnpm-lock.yaml — rebasing required) |
| 2026-08-28T10:05:00Z | CAP-009 | Provider health/verify | Sonnet QC | PASS | 0 | 0 | PASS (merge conflict: index.ts — rebasing required) |
| 2026-08-28T10:05:00Z | CAP-010 | Observed overrides | Sonnet QC | PASS | 0 | 0 | PASS (merge conflict: index.ts — rebasing required) |
| 2026-08-28T10:05:00Z | CHAR-007 | Wardrobe versions | Sonnet QC | PASS | 0 | 0 | PASS (merge conflict: character-library index.ts — rebasing required) |
| 2026-08-28T10:05:00Z | KIE-001 | Kie client/auth | Sonnet QC | PASS | 3 | 3 | PASS (merge conflict: docs/provider-capabilities/kie.md add/add — rebasing required) |
| 2026-08-28T10:05:00Z | CAP-005 | Mutually-exclusive-mode validator | Sonnet QC | PASS | 2 | 2 | MERGED |
| 2026-08-28T10:05:00Z | CAP-006 | Pricing/quota model | Sonnet QC | PASS | 3 | 3 | MERGED |
| 2026-08-28T10:05:00Z | CAP-008 | MAX_REASONING mapper | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T10:05:00Z | KIE-002 | Generic task submit/poll | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T10:05:00Z | KIE-003 | Seedance 2.0 Mini profile | Sonnet QC | PASS | 1 | 1 | MERGED |
| 2026-08-28T14:38:00Z | CAP-004 | Reference-count validator | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T14:38:00Z | CHAR-007 | Wardrobe versions | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T14:38:00Z | CORE-001 | Upstream audit + preservation map | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T14:38:00Z | CORE-004 | Project/series/episode schema | Sonnet QC | PASS | 3 | 3 | MERGED |
| 2026-08-28T14:38:00Z | FISH-001 | Fish Audio client | Sonnet QC | PASS | 4 | 4 | MERGED |
| 2026-08-28T14:38:00Z | GHL-001 | GHL auth/config | Sonnet QC | PASS | 1 | 1 | MERGED |
| 2026-08-28T14:38:00Z | KIE-004 | Seedance modes/validation | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T14:38:00Z | KIE-009 | Failure normalization | Sonnet QC | PASS | 3 | 3 | MERGED |
| 2026-08-28T14:38:00Z | CHAR-003 | Candidate generation flow (3 designs) | Sonnet QC | PASS | 0 | 0 | MERGED |
| 2026-08-28T14:38:00Z | CHAR-010 | Series cast links | Sonnet QC | PASS | 2 | 2 | MERGED |
| 2026-08-28T14:38:00Z | CHAR-012 | Series Bible events | Sonnet QC | PASS | 4 | 4 | MERGED |
| 2026-08-28T14:38:00Z | FISH-002 | Voice profile management | Sonnet QC | PASS | 6 | 6 | MERGED |
| 2026-08-28T14:38:00Z | GHL-002 | List/search media | Sonnet QC | PASS | 3 | 3 | MERGED |
| 2026-08-28T14:38:00Z | GHL-007 | URL/file validation | Sonnet QC | PASS | 3 | 3 | MERGED |
| 2026-08-28T14:38:00Z | CHAR-004 | Selection/retry UI-CLI contract | Sonnet QC | PASS | 1 | 1 | MERGED |
| 2026-08-28T14:38:00Z | FISH-004 | Pronunciation dictionary | Sonnet QC | PASS | 1 | 1 | MERGED |

## Batch 5 Merge Records (2026-08-28, batch be5ae16..56ceb82)

| Timestamp (UTC) | Task ID | Component | Checker | Result | Defects Found | Fixes Applied | Final Verdict |
|---|---|---|---|---|---|---|---|
| 2026-08-28T~20:00Z | CAP-007 | CAP-007 | qc-batch | PASS | 2 | 2 | MERGED (PASS) |
| 2026-08-28T~20:00Z | CAP-009 | CAP-009 | qc-batch | PASS | 1 | 1 | MERGED (PASS) |
| 2026-08-28T~20:00Z | CHAR-011 | CHAR-011 | qc-batch | PASS | 6 | 6 | MERGED (PASS) |
| 2026-08-28T~20:00Z | CHAR-014 | CHAR-014 | qc-batch | PASS | 3 | 3 | MERGED (PASS) |
| 2026-08-28T~20:00Z | CORE-005 | CORE-005 | qc-batch | PASS | 3 | 3 | MERGED (PASS) |
| 2026-08-28T~20:00Z | FISH-008 | FISH-008 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | FISH-009 | FISH-009 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | FISH-010 | FISH-010 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-003 | GHL-003 | qc-batch | PASS | 4 | 4 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-004 | GHL-004 | qc-batch | PASS | 1 | 1 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-005 | GHL-005 | qc-batch | PASS | 2 | 2 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-006 | GHL-006 | qc-batch | PASS | 5 | 5 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-008 | GHL-008 | qc-batch | PASS | 2 | 2 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-009 | GHL-009 | qc-batch | PASS | 1 | 1 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-010 | GHL-010 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | GHL-011 | GHL-011 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | KIE-001 | KIE-001 | qc-batch | PASS | 3 | 3 | MERGED (PASS) |
| 2026-08-28T~20:00Z | KIE-005 | KIE-005 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | KIE-006 | KIE-006 | qc-batch | PASS | 3 | 3 | MERGED (PASS) |
| 2026-08-28T~20:00Z | KIE-008 | KIE-008 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | REC-001 | REC-001 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | REC-009 | REC-009 | qc-batch | PASS | 1 | 1 | MERGED (PASS) |
| 2026-08-28T~20:00Z | VID-001 | VID-001 | qc-batch | PASS | 0 | 0 | MERGED (PASS) |
| 2026-08-28T~20:00Z | VID-015 | VID-015 | qc-batch | PASS | 1 | 1 | MERGED (PASS) |
| 2026-08-28T19:38:52Z | VID-008 | regression | merger | REVERTED | 3+1 (typecheck regression surfaced post-merge) | 0 | QC_FIXING — typecheck regression: GraphicsViews.tsx(29,26) TS2345 FrameSize->number; invisible on branch because its tsconfig lacked |
| 2026-08-28T19:38:52Z | SKL-002 | regression | merger | REVERTED | 0+1 (typecheck regression surfaced post-merge) | 0 | QC_FIXING — typecheck regression: integrations/claude/src/project-install.test.ts uses node: imports + import.meta.url without node  |
| 2026-08-28T22:05:00Z | CAP-003 | Character-count validator | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | CAP-010 | Runtime observed capability overrides | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | CORE-007 | Provider job/asset schema | qc-batch (adopted) | PASS | 1 | 1 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | DIR-002 | Concept generator | qc-batch (adopted) | PASS | 2 | 2 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | FISH-003 | TTS generation | qc-batch (adopted) | PASS | 3 | 3 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | FISH-005 | Dialogue cache | qc-batch (adopted) | PASS | 2 | 2 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | FISH-006 | Alignment/timestamps | qc-batch (adopted) | PASS | 4 | 4 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | FISH-007 | Caption output | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | KIE-010 | Contract/smoke tests | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | QC-002 | Character identity comparison | qc-batch (adopted) | PASS | 2 | 2 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | QC-003 | Wardrobe/hair/prop checks | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | QC-004 | Continuity neighbor check | qc-batch (adopted) | PASS | 1 | 1 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | QC-010 | Wan hero/complex fallback | qc-batch (adopted) | PASS | 7 | 7 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | SKL-003 | Claude personal install | qc-batch (adopted) | PASS | 4 | 4 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | SKL-004 | Claude-nine verification | qc-batch (adopted) | PASS | 2 | 2 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | SKL-005 | OpenClaw workspace install | qc-batch (adopted) | PASS | 3 | 3 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | VID-002 | Episodic composition registry | qc-batch (adopted) | PASS | 0 | 0 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | VID-005 | Generated clip layer | qc-batch (adopted) | PASS | 1 | 1 | PASS — merged batch-7 |
| 2026-08-28T22:05:00Z | VID-013 | Selective shot replacement | qc-batch (adopted) | PASS | 2 | 2 | PASS — merged batch-7 |

| 2026-08-28T19:57:36Z | SKL-004 | Claude-nine verification | merger | PASS | 2 | 2 | PASS — merged batch-8 (fef49fc); batch-7 row over-stamped, corrected |
| 2026-08-28T19:57:36Z | VID-002 | Episodic composition registry | merger | PASS | 0 | 0 | PASS — merged batch-8 (a8fa4ea); batch-7 row over-stamped, corrected |
| 2026-08-28T19:57:36Z | QC-003 | Wardrobe/hair/prop checks | merger | PASS | 0 | 0 | PASS — merged batch-8 (692b20f); batch-7 row over-stamped, corrected |
| 2026-08-28T19:57:36Z | QC-004 | Continuity neighbor check | merger | PASS | 1 | 1 | PASS — merged batch-8 (b43743a); batch-7 row over-stamped, corrected |
| 2026-08-28T19:57:36Z | QC-010 | Wan hero/complex fallback | merger | PASS | 7 | 7 | PASS — batch-8 conflict-blocked (packages/qc/src/index.ts), rebase required |
| 2026-08-28T20:30:00Z | QC-010 | Wan hero/complex fallback | merger | PASS | 7 | 7 | PASS — merged batch-9 (47f919e); rebase-2 onto 1e06ddb resolved the packages/qc/src/index.ts conflict; wan route + policy + 663-line tests in |
| 2026-08-28T20:30:00Z | VID-008 | Native graphics layer | merger | PASS | 2 | 2 | PASS — merged batch-9 (f99eea4): cycle-2 re-admission after IQ-B6 revert; revert-remerge trap resolved by restoring the 12 untouched graphics core files; tsconfig conflict taken from integration; tsc RC=0, 93/93 graphics tests |
| 2026-08-28T23:35:00Z | CORE-008 | Approval state machine + gates | merger | PASS | 2 | 2 | PASS — merged batch-10 (afe126e): unknown-gate keys throw, store returns frozen documents; approvals + gate-machine suites green |
| 2026-08-28T23:35:00Z | CORE-009 | Cost/quota reservations engine | merger | PASS | 2 | 2 | PASS — merged batch-10 (362a985): reserve joins caller transactions; magnitude-safe sub-cent check; ledger suite 423-line green |
| 2026-08-28T23:35:00Z | CORE-015 | Database backup/export | merger | PASS | 1 | 1 | PASS — merged batch-10 (b2992b9): async export handler failure records exit 1 instead of unhandled rejection; round-trip restore green |
| 2026-08-28T23:35:00Z | QC-005 | Video direct vs extracted-frame route | merger | PASS | 2 | 2 | PASS — merged batch-10 (73de2a2): stem path-traversal guard + count validation in frame planner; route suite 24/24 |
| 2026-08-28T23:35:00Z | SKL-002 | Claude project install | merger | PASS | 2 | 2 | PASS — merged batch-10 (dfa9ba7): cycle-2 re-admission after IQ-B6 revert; node-types fix verified on integration (tsc clean, 45/45 claude tests) |
| 2026-08-28T23:35:00Z | QC-007 | Agnes flash route | merger | FAIL | 3 | 2 | NOT ADMITTED — defectsFound 3 > defectsFixed 2; back to fixer |
| 2026-08-29T02:20:00Z | CHAR-005 | Lock/canonical state transition | merger | PASS | 3 | 3 | PASS — merged batch-11 (2e1fb2a): locking suite in packages/character-library/src/locking green on integration |
| 2026-08-29T02:20:00Z | CHAR-013 | Canon proposal approval (gate 6) | merger | PASS | 3 | 3 | PASS — merged batch-11 (dd9106a): canon-approval 600-line test suite green on integration |
| 2026-08-29T02:20:00Z | DIR-003 | Concept approval gate (gate 1) | merger | PASS | 0 | 0 | PASS — merged batch-11 (88cc4dc): concept approval + develop-concept CLI wired, 1756 insertions |
| 2026-08-29T02:20:00Z | DIR-008 | Script approval gate (gate 2) | merger | PASS | 0 | 0 | PASS — merged batch-11 (ff2ce06): screenplay approval guard + write-script CLI wired |
| 2026-08-29T02:20:00Z | DIR-015 | Storyboard approval gate (gate 4) | merger | PASS | 4 | 4 | PASS — merged batch-11 (0c174e1): storyboard approval + CLI commands, 515-line command tests |
| 2026-08-29T02:20:00Z | QC-007 | Agnes Flash acceptance route | merger | PASS | 2 | 2 | PASS — merged batch-11 (c5802ad): round-2 QC verified 94ce8b2, 28/28 flash route tests green on integration; batch-10 rejection (3>2) superseded — 3rd item was repo-wide lint infra gap, control 3f55d17 already recorded 2/2 PASS |
| 2026-08-29T02:20:00Z | QC-011 | Human REVIEW state | merger | PASS | 3 | 3 | PASS — merged batch-11 (4006d69): human-review store/decide + qc CLI surface, 466-line suite |
| 2026-08-29T02:20:00Z | REL-001 | Clean install | merger | PASS | 3 | 3 | PASS — merged batch-11 (00d4bca): clean-install.sh + docs/installation.md, 402-line test |
| 2026-08-29T02:20:00Z | REC-010 | Restart simulation | merger | HOLD | 1 | 1 | NOT ADMITTED batch-11 — deps REC-002..REC-005 unmerged; remains PASS awaiting merge engine |
| 2026-08-29T04:40:00Z | REC-002 | PreCompact hook | merger | PASS | 1 | 1 | PASS — merged batch-12 (36c9a62): certified sha d161bb16; add/add on .claude/settings.json resolved by hook union |
| 2026-08-29T04:40:00Z | REC-003 | PostCompact hook | merger | PASS | 1 | 1 | PASS — merged batch-12 (f706e04): certified sha 1a666d5a; settings.json union keeps all hook events |
| 2026-08-29T04:40:00Z | REC-004 | SessionStart hook | merger | PASS | 2 | 2 | PASS — merged batch-12 (3822ff5): certified sha 098d61e; settings.json union |
| 2026-08-29T04:40:00Z | REC-005 | SessionEnd hook | merger | PASS | 2 | 2 | PASS — merged batch-12 (42f5146): certified sha 3458611e; settings.json union |
| 2026-08-29T04:40:00Z | REC-006 | TaskCompleted hook | merger | PASS | 2 | 2 | PASS — merged batch-12 (7a5dde4): certified sha e7a7f0f; settings.json union |
| 2026-08-29T04:40:00Z | REC-007 | TeammateIdle hook | merger | PASS | 3 | 3 | PASS — merged batch-12 (ec03405): certified sha 3b15bbf9; settings.json union completes 6/6 hook events |
| 2026-08-29T04:40:00Z | REL-002 | Full regression | merger | PASS | 0 | 0 | PASS — merged batch-12 (2478ef6): certified sha bc4bac56, tip b0a4e45 sha-record follow-on; acceptance 17/17 on integration (requires remotion npm ci — standalone workspace) |
| 2026-08-29T04:40:00Z | REC-010 | Restart simulation | merger | HOLD | 1 | 1 | NOT ADMITTED batch-12 — deps now all MERGED, but qc-certified sha 3588299 is not an ancestor of rebased tip 8fd8217; needs re-certification before admission |
