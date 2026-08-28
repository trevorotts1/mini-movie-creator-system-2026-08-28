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
- [x] CAP-004 reference-count validator QC PASS (conflict: rebasing required)
- [x] CAP-007 reasoning/vision LLM registry QC PASS (conflict: rebasing required)
- [x] CAP-009 provider health/verify QC PASS (conflict: rebasing required)
- [x] CAP-010 observed overrides QC PASS (conflict: rebasing required)
- [x] KIE-002 generic task submit/poll merged (batch 2, 54abd40)
- [x] KIE-003 Seedance 2.0 Mini profile merged (batch 2, e973ac2)
- [x] KIE-001 Kie client/auth QC PASS (conflict: rebasing required)
- [x] CORE-001 upstream audit QC PASS (conflict: rebasing required)
- [x] CHAR-007 wardrobe versions QC PASS (conflict: rebasing required)
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