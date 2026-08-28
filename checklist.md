# Quality Checklist (checklist.md)

**Project:** mini-movie-creator-system (MMCS)
**Updated:** 2026-08-28 (bootstrap)
**Policy:** Items checked only after QC PASS on the corresponding task.

---

## 1. Control Plane Baseline

- [x] State directories created (`state/`, `state/locks/`, `logs/*`, `scripts/orchestration/`, `docs/provider-capabilities/`)
- [x] State JSON files initialized with `schema_version: 1` and validated
- [x] 12 root control markdown files written with complete initial content
- [x] Baseline report and environment docs written and preserved
- [x] Upstream MIT license preserved and attributed
- [x] Git repository pushed to origin main

## 2. Planning Phase

- [ ] `spec.md` updated with full subsystem specifications
- [ ] `task-graph.md` DAG constructed with wave boundaries
- [ ] `todo.md` populated with all tasks
- [ ] `ownership.md` path boundaries locked with zero overlap
- [ ] `tasks.json`, `dependencies.json`, `capabilities.json` populated
- [ ] Human approval gate 1 (Planning Sign-off) passed

## 3. Core Architecture & Database

- [x] SQLite schema migrations initialized and tested
- [x] Capability registry implementation complete
- [x] CAP-005 mutually-exclusive-mode validator merged (batch 2, fff515d)
- [x] CAP-006 pricing/quota model merged (batch 2, 7cf45a1)
- [x] CAP-008 MAX_REASONING mapper merged (batch 2, 1669e5b)
- [x] CAP-004 reference-count validator merged (batch 3, 2fc34f1)
- [x] CAP-007 reasoning/vision LLM registry merged (batch 5, 56ceb82)
- [x] CAP-009 provider health/verify merged (batch 5, 56ceb82)
- [x] CAP-010 observed overrides CONFLICT-BLOCKED batch 5 (index.ts, rebase required)
- [x] KIE-002 generic task submit/poll merged (batch 2, 54abd40)
- [x] KIE-003 Seedance 2.0 Mini profile merged (batch 2, e973ac2)
- [x] KIE-004 Seedance modes/validation merged (batch 3, 90ac338)
- [x] KIE-009 Failure normalization merged (batch 3, 2f79d22)
- [x] KIE-001 Kie client/auth merged (batch 5, 56ceb82)
- [x] CORE-001 upstream audit merged (batch 3, b1631a3)
- [x] CORE-004 project/series/episode schema merged (batch 3, e12c7bc)
- [x] CHAR-003 candidate generation flow merged (batch 3, e877f9e)
- [x] CHAR-004 selection/retry UI-CLI contract merged (batch 3, e1c075e)
- [x] CHAR-007 wardrobe versions merged (batch 3, 40765af)
- [x] CHAR-010 series cast links merged (batch 3, d260ead)
- [x] CHAR-012 series bible events merged (batch 3, 8f1446c)
- [x] FISH-001 Fish Audio client merged (batch 3, e6d5b48)
- [x] FISH-002 voice profile management merged (batch 3, 469b245)
- [x] FISH-004 pronunciation dictionary merged (batch 3, 0a820f3)
- [x] GHL-001 GHL auth/config merged (batch 3, de8c967)
- [x] GHL-002 list/search media merged (batch 3, 0b650af)
- [x] GHL-007 URL/file validation merged (batch 3, 9a9fc4c)
- [x] Async job safety harness running with idempotency keys
- [ ] Asset manifest data model defined and tested

## 4. Providers & Pipelines

- [ ] Image provider adapters tested against capability registry
- [ ] Video router implementing provider failover and budget checks
- [ ] Fish Audio TTS client integration verified
- [ ] Remotion + FFmpeg rendering verified end-to-end

## 5. Guardrails & Cost Engine

- [ ] Hard $25 cost ceiling enforced on test runs
- [ ] Prompt and reference budget managers operational
- [ ] Automated QC checks integrated into build loop
- [ ] 6 approval gates wired into runtime flow

## 6. Skills & Deployment Readiness

- [ ] Claude Code, claude-nine, and OpenClaw skills written and tested
- [ ] Standalone app boots and resumes from `state/checkpoint.json`
- [ ] Security baseline passes automated scan (no keys, no leaks)
- [ ] Full regression test suite passing on clean clone

## Batch 5 Merge Evidence (2026-08-28, be5ae16..56ceb82)

- [x] Regression PASS: `pnpm -r test` exit 0 (17/17 packages Done, 0 failures)
- [x] Regression PASS: `pnpm -r run typecheck` exit 0 (all packages clean)
- [x] Pushed origin/integration (56ceb82 + control edc6c51), never force-pushed
- [x] Merged (24): CAP-007, CAP-009, CHAR-011, CHAR-014, CORE-005, FISH-008, FISH-009, FISH-010, GHL-003, GHL-004, GHL-005, GHL-006, GHL-008, GHL-009, GHL-010, GHL-011, KIE-001, KIE-005, KIE-006, KIE-008, REC-001, REC-009, VID-001, VID-015
- [x] CAP-010 conflict on packages/capability-registry/src/index.ts — aborted, branch retains PASS (rebase required)
- [x] CORE-006, CORE-007 conflict on packages/database/src/repositories/index.ts — aborted, branches retain PASS (rebase required)
- [x] KIE-010 conflict on docs/provider-capabilities/kie.md (add/add) — aborted, branch retains PASS (rebase required)

## Batch 6 Merge Evidence (2026-08-28T19:39:10Z, 9c90d71..01d5505)

- [x] Regression PASS: `pnpm -r test` exit 0 (0 failures); `pnpm -r run typecheck` exit 0 (17/17 packages Done)
- [x] Pushed origin/integration (01d5505), never force-pushed
- [x] Merged (44): AGN-001, AGN-002, AGN-003, AGN-004, AGN-005, AGN-006, AGN-007, AGN-008, AGN-009, AGN-010, CHAR-015, CORE-006, DIR-001, DIR-004, DIR-005, DIR-006, DIR-007, DIR-009, DIR-010, DIR-011, DIR-012, DIR-013, DIR-014, GHL-012, KIE-007, QC-001, QC-006, QC-008, QC-009, QC-012, REC-008, SKL-001, SKL-006, SKL-007, VID-003, VID-004, VID-006, VID-007, VID-009, VID-010, VID-011, VID-012, VID-014, VID-016
- [x] VID-008 merged then reverted (4e9e71e) — typecheck regression GraphicsViews.tsx(29,26) TS2345; task back to QC_FIXING
- [x] SKL-002 merged then reverted (01d5505) — integrations/claude typecheck regression (node: imports without node types); task back to QC_FIXING
- [x] Conflict/branch-blocked (11): CORE-007, DIR-002, QC-002, QC-003, QC-004, QC-010, REC-010, SKL-003, SKL-004, SKL-005, VID-005, VID-013 (12 total minus VID-008/SKL-002 which are reverts)

## Batch 7 (2026-08-28T22:05:00Z)

- [x] Batch-7 merged 19 QC-PASS tasks deps-first onto integration: CAP-003, CAP-010, CORE-007, DIR-002, FISH-003, FISH-005, FISH-006, FISH-007, KIE-010, QC-002, QC-003, QC-004, QC-010, SKL-003, SKL-004, SKL-005, VID-002, VID-005, VID-013 (range 38974b3..6d8cce1, pushed)
- [x] Regression PASS: pnpm -r test exit 0 (openclaw 23/23, claude 27/27, cli 63/63), pnpm -r typecheck exit 0, repo-wide vitest 3188 passed / 1 skipped
- [x] Conflict-blocked rebase required: QC-003, QC-004, QC-010 (packages/qc/src/index.ts), SKL-004 (integrations/claude/tsconfig.json), VID-002 (packages/remotion-runtime/src/index.ts)
- [x] Not admitted: REC-010 (deps REC-002..REC-005 unmerged)
- [x] New unblocks: CORE-009, CORE-015 -> READY
