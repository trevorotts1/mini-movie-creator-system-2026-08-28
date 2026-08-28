# MMCS LIVE TASK LIST (todo.md)

Source: runbook §24 (BUILD TASK DECOMPOSITION) + §9 (workflow topology) + spec.md §1 (package layout). Replaces the bootstrap seed of 2026-08-28 08:03.
Total tasks: **149** — READY: **21** — BLOCKED: **12**.

## Wave-1 READY set (all 130 READY tasks below dispatch at wave launch)

WF01 CORE-001,002,003,010,011,012,013,014 · WF02 CHAR-001,002,003,004,006,007,008,009,010,011,012,014,015 · WF03 DIR-001,002,004,005,006,007,009,010,011,012,013,014 · WF09 CAP-001..010, QC-001..010,012 · WF04 AGN-001..010 · WF05 KIE-001..010 · WF06 FISH-001..010 · WF07 GHL-001..012 · WF08 VID-001..016 · WF10 SKL-001..007, REC-001..011.

## BLOCKED set (19)

CORE-004, CORE-005, CORE-006, CORE-007, CORE-008, CORE-009, CORE-015 (need CORE-003 migration runner / schema tables / CORE-008 gate persistence) · CHAR-005, CHAR-013 (need CORE-008) · DIR-003, DIR-008, DIR-015 (need CORE-008) · QC-011 (needs CORE-008) · REL-001..006 (wave-3 release: depends on all area tasks).

## Status policy (binding)

- **READY** = dispatchable in wave 1. Where a listed dependency is itself BLOCKED or still in-flight, the task is marked READY only because it builds **contract-first** against the spec-defined interfaces (spec §55: split shared seams behind interfaces; spec.md is the contract). The dependency task owns the persistence/integration binding.
- **BLOCKED** = a listed dependency genuinely must exist in merged code before any work compiles/tests (schema tasks on the CORE-003 migration runner; gate-persisting tasks on CORE-008; all REL-* on wave-3 release state).
- Statuses live: READY | ACTIVE | BUILDER_DONE | QC_FIXING | PASS | BLOCKED | MERGED (runbook §4.1). This file starts every task READY or BLOCKED.

## Field conventions

- Builder/QC-Fixer: assigned at wave launch (runbook §1.6: Builder=Opus role, QC/Fixer=Sonnet role).
- Branch: `task/<TASK-ID>-<slug>` off `origin/integration`; Worktree: `worktrees/<TASK-ID>/` (runbook §8).
- Test commands assume repo root + `npx vitest run <path>` (spec §30: MMCS adds vitest; Remotion checks = `npm run gen` + `npx tsc --noEmit`).

---

## WF01 — CORE / STATE / DATABASE

- [x] TASK-CORE-001 — Audit upstream packages/scripts + preservation map
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: NONE
  - Owns: docs/upstream-audit/, BASELINE-REPORT.md (append audit section)
  - Branch: task/TASK-CORE-001-upstream-audit
  - Worktree: worktrees/TASK-CORE-001/
  - Acceptance: docs/upstream-audit/preservation-map.md exists and lists every upstream package/script/tool with keep|rewrite|drop + reason; PF-1 and PF-2 carried forward; decisions reconciled against spec §2 facts; verified by `test -s docs/upstream-audit/preservation-map.md && grep -q "PF-1" docs/upstream-audit/preservation-map.md`.
  - Status: MERGED

- [x] TASK-CORE-002 — Target monorepo/module layout
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-001
  - Owns: packages/ (all package skeletons), apps/, integrations/, tsconfig.base.json, root package.json workspaces field
  - Branch: task/TASK-CORE-002-monorepo-layout
  - Worktree: worktrees/TASK-CORE-002/
  - Acceptance: all 11 packages + 3 apps + 2 integrations dirs exist with package.json; `npm install && npx tsc --noEmit -p tsconfig.base.json` passes; `node -e "require('./package.json').workspaces"` lists packages/*.
  - Status: MERGED

- [x] TASK-CORE-003 — SQLite connection + migrations runner
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002
  - Owns: packages/database/src/connection/, packages/database/src/migrations/, packages/database/src/migrations/000-init/
  - Branch: task/TASK-CORE-003-sqlite-migrations
  - Worktree: worktrees/TASK-CORE-003/
  - Acceptance: migration runner applies + rolls back idempotently; repository interfaces exported; `npx vitest run packages/database/src/migrations` green (includes open/close/transaction/migration-order tests on a temp file DB).
  - Status: MERGED

- [x] TASK-CORE-004 — Project/series/episode schema
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003
  - Owns: packages/database/src/migrations/001-projects/, packages/database/src/repositories/projects/, packages/database/src/repositories/series/, packages/database/src/repositories/episodes/
  - Branch: task/TASK-CORE-004-project-schema
  - Worktree: worktrees/TASK-CORE-004/
  - Acceptance: migrations create projects/series/episodes tables incl. aspect-ratio + per-episode override fields (spec §23); repositories CRUD-tested; `npx vitest run packages/database/src/repositories/projects` green.
  - Status: MERGED

- [x] TASK-CORE-005 — Character/location/appearance schema
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003
  - Owns: packages/database/src/migrations/002-characters/, packages/database/src/repositories/characters/, packages/database/src/repositories/locations/, packages/database/src/repositories/appearances/
  - Branch: task/TASK-CORE-005-character-schema
  - Worktree: worktrees/TASK-CORE-005/
  - Acceptance: tables for characters, identity versions (immutable history), appearance versions w/ effective-episode, locations/props; GHL file/folder ID + sha256 columns present (spec §9); `npx vitest run packages/database/src/repositories/characters` green incl. version-history immutability test.
  - Status: MERGED

- [x] TASK-CORE-006 — Scene/shot/reference schema
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003
  - Owns: packages/database/src/migrations/003-scenes/, packages/database/src/repositories/scenes/, packages/database/src/repositories/shots/, packages/database/src/repositories/references/
  - Branch: task/TASK-CORE-006-scene-shot-schema
  - Worktree: worktrees/TASK-CORE-006/
  - Acceptance: shot table carries every field of spec §12 Shot Specification Record (verified by a schema-introspection test listing all 28 required fields); `npx vitest run packages/database/src/repositories/shots` green.
  - Status: MERGED

- [x] TASK-CORE-007 — Provider job/asset schema
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003
  - Owns: packages/database/src/migrations/004-jobs-assets/, packages/database/src/repositories/jobs/, packages/database/src/repositories/assets/
  - Branch: task/TASK-CORE-007-job-asset-schema
  - Worktree: worktrees/TASK-CORE-007/
  - Acceptance: provider_jobs + assets tables carry every field of spec §19 asset manifest (all 26 fields asserted by introspection test) and §18 job-safety fields; job state enum covers PLANNED..REJECTED; `npx vitest run packages/database/src/repositories/jobs` green.
  - Status: MERGED

- [ ] TASK-CORE-008 — Approval state machine + gates
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003, CORE-004
  - Owns: packages/core/src/approvals/, packages/core/src/state-machine/
  - Branch: task/TASK-CORE-008-approval-gates
  - Worktree: worktrees/TASK-CORE-008/
  - Acceptance: 6 gates (concept, script, character, storyboard, rough cut, canon) persisted as domain states; illegal transitions throw; `npx vitest run packages/core/src/approvals` green incl. gate-ordering + persistence tests.
  - Status: READY

- [ ] TASK-CORE-009 — Cost/quota reservations engine
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003, CORE-007
  - Owns: packages/cost-engine/
  - Branch: task/TASK-CORE-009-cost-engine
  - Worktree: worktrees/TASK-CORE-009/
  - Acceptance: $24.99 cumulative projected proceeds automatically; request reaching $25.00 stops for approval; two concurrent reservations cannot bypass (atomic against one ledger — run 5 parallel reservations of $24.99, exactly 1 succeeds); included quota tracked separately; `npx vitest run packages/cost-engine` green.
  - Status: READY

- [x] TASK-CORE-010 — Config/env validation loader
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002
  - Owns: packages/core/src/config/, .env.example, .gitignore (env entries)
  - Branch: task/TASK-CORE-010-config-loader
  - Worktree: worktrees/TASK-CORE-010/
  - Acceptance: loads + zod-validates AGNES_API_KEY, KIE_API_KEY, FISH_API_KEY, GHL_ACCESS_TOKEN, GHL_LOCATION_ID, OPENROUTER_API_KEY, NINEROUTER_URL, NINEROUTER_KEY, AUTO_SPEND_LIMIT_USD (default 25.00); missing-var error names the variable; .env.example has names+descriptions only; `npx vitest run packages/core/src/config` green; `git check-ignore .env` exits 0.
  - Status: MERGED

- [x] TASK-CORE-011 — `mmcs` CLI bootstrap
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010
  - Owns: apps/cli/
  - Branch: task/TASK-CORE-011-cli-bootstrap
  - Worktree: worktrees/TASK-CORE-011/
  - Acceptance: command registry + argument parsing for the full verb list in spec §24 (doctor, status, create-series … recover) with stub handlers; `npx vitest run apps/cli` green; `node apps/cli/dist/index.js doctor` exits 0 (or documented stub output).
  - Status: MERGED

- [x] TASK-CORE-012 — Structured logging
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002
  - Owns: packages/core/src/logging/
  - Branch: task/TASK-CORE-012-logging
  - Worktree: worktrees/TASK-CORE-012/
  - Acceptance: structured JSON logger with levels + task-id/agent fields; redaction hook that scrubs values matching token/key patterns (test proves a fake API key never reaches output); `npx vitest run packages/core/src/logging` green.
  - Status: MERGED

- [x] TASK-CORE-013 — Idempotency primitives
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002
  - Owns: packages/core/src/idempotency/
  - Branch: task/TASK-CORE-013-idempotency
  - Worktree: worktrees/TASK-CORE-013/
  - Acceptance: atomic file write (temp+rename), request-hash idempotency keys, once-only execution guard; duplicate submit attempt returns original result; `npx vitest run packages/core/src/idempotency` green incl. crash-mid-write test.
  - Status: MERGED

- [x] TASK-CORE-014 — Recovery checkpoint service
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-013
  - Owns: packages/core/src/recovery/, state/ (schema + writers for checkpoint.json)
  - Branch: task/TASK-CORE-014-checkpoint-service
  - Worktree: worktrees/TASK-CORE-014/
  - Acceptance: checkpoint.json written atomically with runbook §5 fields; kill -9 mid-write leaves previous valid checkpoint; reload reconstructs ready/blocked/mergeQueue ids; `npx vitest run packages/core/src/recovery` green.
  - Status: MERGED

- [ ] TASK-CORE-015 — Database backup/export
  - Workflow: WF01
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-003, CORE-004, CORE-005, CORE-006, CORE-007
  - Owns: packages/database/src/backup/, apps/cli/src/commands/backup/
  - Branch: task/TASK-CORE-015-db-backup
  - Worktree: worktrees/TASK-CORE-015/
  - Acceptance: `mmcs backup export` produces a restorable archive; restore into empty DB passes full row-count + checksum comparison; `npx vitest run packages/database/src/backup` green incl. round-trip test.
  - Status: READY

## WF02 — SERIES BIBLE / CHARACTER

- [x] TASK-CHAR-001 — Global character stable IDs
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/ids/
  - Branch: task/TASK-CHAR-001-character-ids
  - Worktree: worktrees/TASK-CHAR-001/
  - Acceptance: `CHAR_<NAME>_<NNN>` stable business-ID generator + validator (spec §9); never display-name-keyed; collision test proves 1000 generated IDs unique; `npx vitest run packages/character-library/src/ids` green.
  - Status: MERGED

- [x] TASK-CHAR-002 — Canonical identity asset metadata
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/identity-asset/
  - Branch: task/TASK-CHAR-002-identity-asset
  - Worktree: worktrees/TASK-CHAR-002/
  - Acceptance: asset record carries every field of spec §9 canonical identity record (asset ID, character ID, identity version, ghlFileId, ghlFolderId, ghlUrl, sha256, local cache, dimensions, provider/model, source job ID, prompt, approval state, canonical flag); schema test asserts all fields; `npx vitest run packages/character-library/src/identity-asset` green.
  - Status: MERGED

- [x] TASK-CHAR-003 — Candidate generation flow (3 designs)
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/candidates/
  - Branch: task/TASK-CHAR-003-candidate-flow
  - Worktree: worktrees/TASK-CHAR-003/
  - Acceptance: new character request produces exactly 3 candidates as DRAFT/REVIEW; Try Again creates 3 NEW candidates; rejected candidates never selectable (state-machine test); `npx vitest run packages/character-library/src/candidates` green.
  - Status: MERGED

- [x] TASK-CHAR-004 — Selection/retry UI-CLI contract
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-011, CHAR-003
  - Owns: apps/cli/src/commands/choose-character/, apps/cli/src/commands/approve-character/
  - Branch: task/TASK-CHAR-004-selection-contract
  - Worktree: worktrees/TASK-CHAR-004/
  - Acceptance: `mmcs choose-character <1|2|3|4>` maps 4=Try Again; `mmcs approve-character <id>` requires gate 3; invalid selections rejected with usage text; `npx vitest run apps/cli/src/commands/choose-character` green.
  - Status: MERGED

- [ ] TASK-CHAR-005 — Lock/canonical state transition
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, CHAR-002, CHAR-003
  - Owns: packages/character-library/src/locking/
  - Branch: task/TASK-CHAR-005-lock-canonical
  - Worktree: worktrees/TASK-CHAR-005/
  - Acceptance: LOCK CHARACTER approval → candidate asset states transition DRAFT→APPROVED→CANONICAL; lock without approval throws; REJECTED never becomes CANONICAL (test); `npx vitest run packages/character-library/src/locking` green.
  - Status: BLOCKED

- [x] TASK-CHAR-006 — Appearance versions (effective episode)
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/appearance-versions/
  - Branch: task/TASK-CHAR-006-appearance-versions
  - Worktree: worktrees/TASK-CHAR-006/
  - Acceptance: hair/wardrobe change creates new appearance version with effective episode/time; historical episodes resolve canon-at-the-time version (Monica v1 braids E01–E08, v2 short from E09 test); base identity master never replaced; `npx vitest run packages/character-library/src/appearance-versions` green.
  - Status: MERGED

- [x] TASK-CHAR-007 — Wardrobe versions
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CHAR-006
  - Owns: packages/character-library/src/wardrobe/
  - Branch: task/TASK-CHAR-007-wardrobe-versions
  - Worktree: worktrees/TASK-CHAR-007/
  - Acceptance: wardrobe states versioned per character; active-wardrobe resolution for an episode continuity point; `npx vitest run packages/character-library/src/wardrobe` green.
  - Status: MERGED

- [x] TASK-CHAR-008 — Hair versions
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CHAR-006
  - Owns: packages/character-library/src/hair/
  - Branch: task/TASK-CHAR-008-hair-versions
  - Worktree: worktrees/TASK-CHAR-008/
  - Acceptance: hair states versioned per character; change never overwrites identity history; `npx vitest run packages/character-library/src/hair` green.
  - Status: MERGED

- [x] TASK-CHAR-009 — Fish voice binding
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/voice-binding/
  - Branch: task/TASK-CHAR-009-voice-binding
  - Worktree: worktrees/TASK-CHAR-009/
  - Acceptance: voice profile record per spec §16 (character ID, Fish voice/reference ID, model, pace, emotion/style, pronunciation dictionary, proper nouns, test sample status, approval state); recurring character voice never randomly changes across episodes (determinism test); `npx vitest run packages/character-library/src/voice-binding` green.
  - Status: MERGED

- [x] TASK-CHAR-010 — Series cast links
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-004, CORE-005
  - Owns: packages/character-library/src/cast/
  - Branch: task/TASK-CHAR-010-cast-links
  - Worktree: worktrees/TASK-CHAR-010/
  - Acceptance: global library ↔ per-series cast join; cast resolution by episode; removing series cast never deletes global character; `npx vitest run packages/character-library/src/cast` green.
  - Status: MERGED

- [x] TASK-CHAR-011 — Recurring location library
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-005
  - Owns: packages/character-library/src/locations/
  - Branch: task/TASK-CHAR-011-location-library
  - Worktree: worktrees/TASK-CHAR-011/
  - Acceptance: location masters with approved wide/medium/reverse angles + day/night states; resolution by episode continuity point; `npx vitest run packages/character-library/src/locations` green.
  - Status: MERGED

- [x] TASK-CHAR-012 — Series Bible events
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-004
  - Owns: packages/character-library/src/series-bible/
  - Branch: task/TASK-CHAR-012-series-bible
  - Worktree: worktrees/TASK-CHAR-012/
  - Acceptance: bible stores premise, world rules, characters, relationships, locations, wardrobe, props, visual style, camera language, voice profiles, timeline, episode summaries, plot threads, versioned canon changes (spec §10); historical episodes read canon-at-time; `npx vitest run packages/character-library/src/series-bible` green.
  - Status: MERGED

- [ ] TASK-CHAR-013 — Canon proposal approval (gate 6)
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, CHAR-012
  - Owns: packages/character-library/src/canon-approval/
  - Branch: task/TASK-CHAR-013-canon-approval
  - Worktree: worktrees/TASK-CHAR-013/
  - Acceptance: end-of-episode proposal produces Proposed Canon Changes list; no permanent canon update without approval; approved proposals create new version; `npx vitest run packages/character-library/src/canon-approval` green.
  - Status: BLOCKED

- [x] TASK-CHAR-014 — GHL asset-link refresh/fallback
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, GHL-008
  - Owns: packages/character-library/src/asset-links/
  - Branch: task/TASK-CHAR-014-asset-links
  - Worktree: worktrees/TASK-CHAR-014/
  - Acceptance: canonical GHL file ID + URL + checksum resolved verbatim in downstream reference plans; stale-link refresh via manifest; local-cache-removal resolution test passes against mocked GHL; `npx vitest run packages/character-library/src/asset-links` green.
  - Status: MERGED

- [ ] TASK-CHAR-015 — Character reference-pack metrics
  - Workflow: WF02
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-007
  - Owns: packages/character-library/src/refpack-metrics/
  - Branch: task/TASK-CHAR-015-refpack-metrics
  - Worktree: worktrees/TASK-CHAR-015/
  - Acceptance: persists which references produced accepted vs rejected clips; historical success rate queryable per character/model/reference combination (feeds DIR-013 scoring); `npx vitest run packages/character-library/src/refpack-metrics` green.
  - Status: BUILDER_DONE

## WF03 — STORY / SCENE / REFERENCE (directing)

- [ ] TASK-DIR-001 — Idea intake schema
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-004
  - Owns: packages/scene-intelligence/src/intake/
  - Branch: task/TASK-DIR-001-idea-intake
  - Worktree: worktrees/TASK-DIR-001/
  - Acceptance: idea record (raw text, aspect ratio, target runtime, series link) validated; story text treated as untrusted data (spec §29 — injection test passes); `npx vitest run packages/scene-intelligence/src/intake` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-002 — Concept generator
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, DIR-001
  - Owns: packages/scene-intelligence/src/concept/
  - Branch: task/TASK-DIR-002-concept-generator
  - Worktree: worktrees/TASK-DIR-002/
  - Acceptance: idea → developed concept via director-model interface (OpenRouter-compatible, CAP-007 registry); mocked-LLM test produces concept options; no provider call without capability check; `npx vitest run packages/scene-intelligence/src/concept` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-003 — Concept approval gate (gate 1)
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, DIR-002
  - Owns: packages/scene-intelligence/src/concept/approval/, apps/cli/src/commands/develop-concept/
  - Branch: task/TASK-DIR-003-concept-approval
  - Worktree: worktrees/TASK-DIR-003/
  - Acceptance: no screenplay work while concept unapproved (state throws); `mmcs develop-concept` + `mmcs approve concept` wired; `npx vitest run packages/scene-intelligence/src/concept/approval` green.
  - Status: BLOCKED

- [ ] TASK-DIR-004 — Screenplay generator
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, DIR-001
  - Owns: packages/scene-intelligence/src/screenplay/
  - Branch: task/TASK-DIR-004-screenplay-generator
  - Worktree: worktrees/TASK-DIR-004/
  - Acceptance: approved concept → screenplay via writer-model interface; output structured (scenes, dialogue, characters); mocked-LLM test; `npx vitest run packages/scene-intelligence/src/screenplay` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-005 — Runtime estimator
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-004
  - Owns: packages/scene-intelligence/src/runtime-estimator/
  - Branch: task/TASK-DIR-005-runtime-estimator
  - Worktree: worktrees/TASK-DIR-005/
  - Acceptance: screenplay → estimated runtime within ±10% on fixture screenplays (test with known-duration fixtures); per-scene and total estimates persisted; `npx vitest run packages/scene-intelligence/src/runtime-estimator` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-006 — Script critic/QC
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, DIR-004
  - Owns: packages/scene-intelligence/src/script-critic/
  - Branch: task/TASK-DIR-006-script-critic
  - Worktree: worktrees/TASK-DIR-006/
  - Acceptance: critic-model interface returns structured findings (pacing, continuity, dialogue, character consistency) on fixture screenplay; findings schema versioned; `npx vitest run packages/scene-intelligence/src/script-critic` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-007 — Script revision loop
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-004, DIR-006
  - Owns: packages/scene-intelligence/src/script-revision/
  - Branch: task/TASK-DIR-007-script-revision
  - Worktree: worktrees/TASK-DIR-007/
  - Acceptance: critic findings → targeted revision → re-criticize; loop bounded (max iterations configurable); convergence test on fixture; `npx vitest run packages/scene-intelligence/src/script-revision` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-008 — Script approval gate (gate 2)
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, DIR-004, DIR-007
  - Owns: packages/scene-intelligence/src/screenplay/approval/, apps/cli/src/commands/write-script/
  - Branch: task/TASK-DIR-008-script-approval
  - Worktree: worktrees/TASK-DIR-008/
  - Acceptance: no cast/candidate work while script unapproved; `mmcs write-script` + `mmcs approve script` wired; `npx vitest run packages/scene-intelligence/src/screenplay/approval` green.
  - Status: BLOCKED

- [ ] TASK-DIR-009 — Scene parser
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-004
  - Owns: packages/scene-intelligence/src/scene-parser/
  - Branch: task/TASK-DIR-009-scene-parser
  - Worktree: worktrees/TASK-DIR-009/
  - Acceptance: approved screenplay → narrative scenes with per-scene characters, location, duration; 45-second reference scene parses to ≥5 named scenes on fixture; `npx vitest run packages/scene-intelligence/src/scene-parser` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-010 — Shot planner
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-006, DIR-009
  - Owns: packages/scene-intelligence/src/shot-planner/
  - Branch: task/TASK-DIR-010-shot-planner
  - Worktree: worktrees/TASK-DIR-010/
  - Acceptance: scenes → shots by dialogue/emotional/action beats; shots inside selected model duration limits; Shot Specification Record fields populated (spec §12); 45s scene → 5–8 shots on fixture; `npx vitest run packages/scene-intelligence/src/shot-planner` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-011 — Scene master planner
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-010, CHAR-011
  - Owns: packages/scene-intelligence/src/scene-master/
  - Branch: task/TASK-DIR-011-scene-master-planner
  - Worktree: worktrees/TASK-DIR-011/
  - Acceptance: multi-character scenes flagged for Scene Master Image; scene-master spec carries identities, wardrobe, room, lighting, props, positions; internal storyboard images marked non-provider-input; `npx vitest run packages/scene-intelligence/src/scene-master` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-012 — Keyframe planner
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-010
  - Owns: packages/scene-intelligence/src/keyframe-planner/
  - Branch: task/TASK-DIR-012-keyframe-planner
  - Worktree: worktrees/TASK-DIR-012/
  - Acceptance: mutually exclusive classification per shot: zero / one / start+end / scene-master+refs / multimodal package (spec §8); classification changes when capability profile changes (fixture test); `npx vitest run packages/scene-intelligence/src/keyframe-planner` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-013 — ReferenceBudgetPlanner
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-012, CHAR-015, CAP-004
  - Owns: packages/scene-intelligence/src/reference-budget/
  - Branch: task/TASK-DIR-013-reference-budget
  - Worktree: worktrees/TASK-DIR-013/
  - Acceptance: minimum-sufficient references (single close-up 1–2; two-character dialogue prefers scene master over portrait stack); scoring by identity/wardrobe/location/prop/pose/start/end/historical-success; never stuffs max slots (test asserts under-limit selection); `npx vitest run packages/scene-intelligence/src/reference-budget` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-014 — Storyboard generator contract
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, DIR-010, DIR-012
  - Owns: packages/scene-intelligence/src/storyboard/
  - Branch: task/TASK-DIR-014-storyboard-contract
  - Worktree: worktrees/TASK-DIR-014/
  - Acceptance: storyboard plan = per-shot image-generation contract (image model by capability profile, spec §15); no paid generation in this task (mocked image client); `npx vitest run packages/scene-intelligence/src/storyboard` green.
  - Status: BUILDER_DONE

- [ ] TASK-DIR-015 — Storyboard approval gate (gate 4)
  - Workflow: WF03
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, DIR-014
  - Owns: packages/scene-intelligence/src/storyboard/approval/, apps/cli/src/commands/storyboard/
  - Branch: task/TASK-DIR-015-storyboard-approval
  - Worktree: worktrees/TASK-DIR-015/
  - Acceptance: no paid generation while storyboard unapproved; `mmcs storyboard` + `mmcs approve-storyboard` wired; `npx vitest run packages/scene-intelligence/src/storyboard/approval` green.
  - Status: BLOCKED

## WF09A — MODEL REGISTRY / CAPABILITIES (CAP-* live in WF09)

- [x] TASK-CAP-001 — Capability schema
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002
  - Owns: packages/capability-registry/src/schema/
  - Branch: task/TASK-CAP-001-capability-schema
  - Worktree: worktrees/TASK-CAP-001/
  - Acceptance: MediaModelCapability TS interface + zod schema exactly per spec §5 (all fields incl. confidence enum VERIFIED/PROVISIONAL/UNKNOWN, incompatibleCombinations); separate registry kinds for reasoning/vision/image/video/voice/storage; `npx vitest run packages/capability-registry/src/schema` green.
  - Status: MERGED

- [x] TASK-CAP-002 — Capability source/date/confidence data
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/data/, docs/provider-capabilities/
  - Branch: task/TASK-CAP-002-capability-data
  - Worktree: worktrees/TASK-CAP-002/
  - Acceptance: seed profiles for Agnes Video 2.5 Flash + regular, Seedance 2.0 Mini, Wan 3.0, Fish S2.1 family, GLM 5.3 Flash / DeepSeek V4 Flash Vision Experimental / Qwen 3.8 Flash / Gemini 3.7 Flash; every value carries lastVerifiedAt + sourceUrls + confidence; UNKNOWN preserved where undocumented (Agnes hard prompt ceiling = UNKNOWN, asserted by test); one docs file per provider family; `npx vitest run packages/capability-registry/src/data` green.
  - Status: MERGED

- [ ] TASK-CAP-003 — Character-count validator
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/validators/character-count.ts
  - Branch: task/TASK-CAP-003-character-count
  - Worktree: worktrees/TASK-CAP-003/
  - Acceptance: counts compiled prompt characters exactly; rejects over hard max BEFORE provider call (Wan >20,000 test); passes when UNKNOWN hard max (never invents a limit); `npx vitest run packages/capability-registry/src/validators` green.
  - Status: BUILDER_DONE

- [x] TASK-CAP-004 — Reference-count validator
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/validators/reference-count.ts
  - Branch: task/TASK-CAP-004-reference-count
  - Worktree: worktrees/TASK-CAP-004/
  - Acceptance: rejects too many Wan reference images (>10) before call; validates images/videos/audio counts per profile; `npx vitest run packages/capability-registry/src/validators` green incl. reference tests.
  - Status: MERGED

- [x] TASK-CAP-005 — Mutually-exclusive-mode validator
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/validators/exclusive-modes.ts
  - Branch: task/TASK-CAP-005-exclusive-modes
  - Worktree: worktrees/TASK-CAP-005/
  - Acceptance: rejects first/last-frame combined with multimodal references (Wan); validates incompatibleCombinations generically; `npx vitest run packages/capability-registry/src/validators` green incl. mode tests.
  - Status: MERGED

- [x] TASK-CAP-006 — Pricing/quota model
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/pricing/
  - Branch: task/TASK-CAP-006-pricing-model
  - Worktree: worktrees/TASK-CAP-006/
  - Acceptance: per-model pricing_unit/current_price/quota/overage consumed by cost estimate; spend estimation test against fixture profiles; `npx vitest run packages/capability-registry/src/pricing` green.
  - Status: MERGED

- [x] TASK-CAP-007 — Reasoning/vision model registry
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001
  - Owns: packages/capability-registry/src/llm-registry/
  - Branch: task/TASK-CAP-007-llm-registry
  - Worktree: worktrees/TASK-CAP-007/
  - Acceptance: OpenRouter-compatible selection; separate slots for director/writer/script-critic/image-QC/video-QC/continuity-QC/final-QC; any compatible model ID accepted (not closed to 4 presets); `npx vitest run packages/capability-registry/src/llm-registry` green.
  - Status: MERGED

- [x] TASK-CAP-008 — MAX_REASONING mapper
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-007
  - Owns: packages/capability-registry/src/max-reasoning/
  - Branch: task/TASK-CAP-008-max-reasoning
  - Worktree: worktrees/TASK-CAP-008/
  - Acceptance: MAX_REASONING logical config maps per-adapter to highest supported reasoning effort; never sends literal "max" to endpoints that reject it (adapter table test); `npx vitest run packages/capability-registry/src/max-reasoning` green.
  - Status: MERGED

- [x] TASK-CAP-009 — Provider health/verify command
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-001, CORE-011
  - Owns: packages/capability-registry/src/verify/, apps/cli/src/commands/providers-verify/
  - Branch: task/TASK-CAP-009-providers-verify
  - Worktree: worktrees/TASK-CAP-009/
  - Acceptance: `mmcs providers verify` reports configured vs documented vs runtime-observed capability + last verified date + discrepancy warning; transient failure never silently rewrites VERIFIED (test); `npx vitest run packages/capability-registry/src/verify` green.
  - Status: MERGED

- [x] TASK-CAP-010 — Runtime observed capability overrides
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-002, CAP-009
  - Owns: packages/capability-registry/src/observed-overrides/
  - Branch: task/TASK-CAP-010-observed-overrides
  - Worktree: worktrees/TASK-CAP-010/
  - Acceptance: runtime-discovered model IDs/limits refine profiles with PROVISIONAL confidence + provenance; VERIFIED values immutable on one transient failure (test); Agnes 2.5 runtime IDs recorded with source/date; `npx vitest run packages/capability-registry/src/observed-overrides` green.
  - Status: MERGED

## WF04 — AGNES / IMAGE / VIDEO

- [ ] TASK-AGN-001 — Agnes auth/client
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, CORE-012
  - Owns: packages/providers/src/agnes/client/
  - Branch: task/TASK-AGN-001-agnes-client
  - Worktree: worktrees/TASK-AGN-001/
  - Acceptance: HTTP client with bearer auth from config, timeout/retry limits (spec §29), token never logged (redaction test); docs inspection source URLs + date recorded in docs/provider-capabilities/agnes.md; `npx vitest run packages/providers/src/agnes/client` green (mocked API).
  - Status: BUILDER_DONE

- [ ] TASK-AGN-002 — Agnes image generation
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-001, CAP-002
  - Owns: packages/providers/src/agnes/image/
  - Branch: task/TASK-AGN-002-agnes-image
  - Worktree: worktrees/TASK-AGN-002/
  - Acceptance: image generation + edit/compose paths per current API (AGN-003 scope merged if API supports); capability profile consulted before request; mocked test produces image record with provider_task_id; `npx vitest run packages/providers/src/agnes/image` green.
  - Status: PASS

- [ ] TASK-AGN-003 — Agnes image edit/compose (conditional)
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-002
  - Owns: packages/providers/src/agnes/image/edit/
  - Branch: task/TASK-AGN-003-agnes-edit
  - Worktree: worktrees/TASK-AGN-003/
  - Acceptance: if current Agnes API supports edit/compose: masked edit + multi-image compose implemented behind capability flags; if unsupported: capability registry records mode unsupported + task closes with documented evidence in docs/provider-capabilities/agnes.md; `npx vitest run packages/providers/src/agnes/image/edit` green either way.
  - Status: PASS

- [ ] TASK-AGN-004 — Agnes video job submit
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-001, CORE-007
  - Owns: packages/providers/src/agnes/video/submit/
  - Branch: task/TASK-AGN-004-agnes-submit
  - Worktree: worktrees/TASK-AGN-004/
  - Acceptance: job submitted with request persisted BEFORE polling (task/job ID in DB first, spec §18); pre-request validation chain runs (character count → references → modes → duration → budget); mocked submit returns job record in SUBMITTED; `npx vitest run packages/providers/src/agnes/video/submit` green.
  - Status: BUILDER_DONE

- [ ] TASK-AGN-005 — Agnes video poll + resume
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-004
  - Owns: packages/providers/src/agnes/video/poll/
  - Branch: task/TASK-AGN-005-agnes-poll
  - Worktree: worktrees/TASK-AGN-005/
  - Acceptance: resume at SUBMITTED polls existing job, never resubmits (kill-poller test: restart → same task ID, no second charge); GENERATED_TEMPORARY persists URL + expiration; `npx vitest run packages/providers/src/agnes/video/poll` green.
  - Status: BUILDER_DONE

- [ ] TASK-AGN-006 — Agnes Flash profile
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-004, CAP-002
  - Owns: packages/providers/src/agnes/profiles/flash/
  - Branch: task/TASK-AGN-006-agnes-flash
  - Worktree: worktrees/TASK-AGN-006/
  - Acceptance: Agnes Video 2.5 Flash profile (720p, 4–12s, ≤5 ref images, first/last-frame, no ref-video, prompt ceiling UNKNOWN); runtime model ID discovered + recorded with source/date (not hard-coded from stale agnes-video-v2.0 docs); profile test; `npx vitest run packages/providers/src/agnes/profiles/flash` green.
  - Status: BUILDER_DONE

- [ ] TASK-AGN-007 — Agnes regular 2.5 profile
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-004, CAP-002
  - Owns: packages/providers/src/agnes/profiles/regular/
  - Branch: task/TASK-AGN-007-agnes-regular
  - Worktree: worktrees/TASK-AGN-007/
  - Acceptance: Agnes Video 2.5 regular profile (4–12s, ≤5 ref images, reference-video support, 720p/960p/2K, prompt ceiling UNKNOWN); reference-video path exercised in mocked test; `npx vitest run packages/providers/src/agnes/profiles/regular` green.
  - Status: PASS

- [ ] TASK-AGN-008 — Agnes first/last/reference validation
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-006, AGN-007
  - Owns: packages/providers/src/agnes/validation/
  - Branch: task/TASK-AGN-008-agnes-validation
  - Worktree: worktrees/TASK-AGN-008/
  - Acceptance: first-frame, last-frame, reference-image request shapes validated against profile before call; invalid combination rejected pre-flight (test); `npx vitest run packages/providers/src/agnes/validation` green.
  - Status: BUILDER_DONE

- [ ] TASK-AGN-009 — Agnes quota accounting
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-001, CORE-009
  - Owns: packages/providers/src/agnes/quota/
  - Branch: task/TASK-AGN-009-agnes-quota
  - Worktree: worktrees/TASK-AGN-009/
  - Acceptance: requested/generated/accepted/rejected seconds + retries + cost recorded per job; included quota tracked separately from paid spend; `npx vitest run packages/providers/src/agnes/quota` green.
  - Status: PASS

- [ ] TASK-AGN-010 — Agnes retry/idempotency
  - Workflow: WF04
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: AGN-005, CORE-013
  - Owns: packages/providers/src/agnes/retry/
  - Branch: task/TASK-AGN-010-agnes-retry
  - Worktree: worktrees/TASK-AGN-010/
  - Acceptance: bounded retry (no unbounded loops, spec §29); same request hash never double-submits; retry count persisted; `npx vitest run packages/providers/src/agnes/retry` green.
  - Status: BUILDER_DONE

## WF05 — KIE / SEEDANCE / WAN

- [x] TASK-KIE-001 — Kie client/auth
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, CORE-012
  - Owns: packages/providers/src/kie/client/
  - Branch: task/TASK-KIE-001-kie-client
  - Worktree: worktrees/TASK-KIE-001/
  - Acceptance: HTTP client, bearer auth from config, timeouts/retries, key never logged; current docs.kie.ai schema facts recorded in docs/provider-capabilities/kie.md with URLs + date; `npx vitest run packages/providers/src/kie/client` green (mocked).
  - Status: MERGED

- [x] TASK-KIE-002 — Generic task submit/poll
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-001, CORE-007
  - Owns: packages/providers/src/kie/task/
  - Branch: task/TASK-KIE-002-kie-task
  - Worktree: worktrees/TASK-KIE-002/
  - Acceptance: generic Kie task abstraction: persist task ID before polling; resume-at-SUBMITTED polls existing task (no resubmit test); state mapping to §18 machine; `npx vitest run packages/providers/src/kie/task` green.
  - Status: MERGED

- [x] TASK-KIE-003 — Seedance 2.0 Mini profile
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-002, CAP-002
  - Owns: packages/providers/src/kie/seedance/
  - Branch: task/TASK-KIE-003-seedance-profile
  - Worktree: worktrees/TASK-KIE-003/
  - Acceptance: Seedance 2.0 Mini adapter per live Kie schema (verify at build; record in docs/provider-capabilities/kie.md); generation modes tracked separately (first-frame I2V / first+last I2V / multimodal-reference); unstated numeric limits stay UNKNOWN/PROVISIONAL; `npx vitest run packages/providers/src/kie/seedance` green.
  - Status: MERGED

- [x] TASK-KIE-004 — Seedance modes/validation
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-003
  - Owns: packages/providers/src/kie/seedance/validation/
  - Branch: task/TASK-KIE-004-seedance-modes
  - Worktree: worktrees/TASK-KIE-004/
  - Acceptance: mutually exclusive modes never combined (pre-flight rejection test); mode selected explicitly per request; `npx vitest run packages/providers/src/kie/seedance/validation` green.
  - Status: MERGED

- [x] TASK-KIE-005 — Wan 3.0 profile
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-002, CAP-002
  - Owns: packages/providers/src/kie/wan/
  - Branch: task/TASK-KIE-005-wan-profile
  - Worktree: worktrees/TASK-KIE-005/
  - Acceptance: Wan 3.0 adapter after live schema/pricing/limits verification recorded in registry (baseline: 20,000-char prompt, ≤10 ref images, ≤5 ref videos, ≤5 ref audio, ≤30s, 480p/720p/1080p — verify, never trust static doc over newer docs); `npx vitest run packages/providers/src/kie/wan` green.
  - Status: MERGED

- [x] TASK-KIE-006 — Wan multimodal validation
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-005
  - Owns: packages/providers/src/kie/wan/validation/
  - Branch: task/TASK-KIE-006-wan-validation
  - Worktree: worktrees/TASK-KIE-006/
  - Acceptance: >20,000-char prompt rejected BEFORE provider call; >10 reference images rejected before call; first/last-frame vs multimodal incompatibility enforced; `npx vitest run packages/providers/src/kie/wan/validation` green (spec §32 media-capability acceptance).
  - Status: MERGED

- [ ] TASK-KIE-007 — Kie cost calculator
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-003, KIE-005, CAP-006
  - Owns: packages/providers/src/kie/cost/
  - Branch: task/TASK-KIE-007-kie-cost
  - Worktree: worktrees/TASK-KIE-007/
  - Acceptance: per-model cost estimate from registry pricing before submission; feeds CORE-009 reservation; fixture test with known pricing; `npx vitest run packages/providers/src/kie/cost` green.
  - Status: BUILDER_DONE

- [x] TASK-KIE-008 — Temporary URL persistence
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-002
  - Owns: packages/providers/src/kie/temp-url/
  - Branch: task/TASK-KIE-008-temp-url
  - Worktree: worktrees/TASK-KIE-008/
  - Acceptance: GENERATED_TEMPORARY persists provider URL + expiration immediately; archival handoff to GHL store triggered (GHL-012 integration point); `npx vitest run packages/providers/src/kie/temp-url` green.
  - Status: MERGED

- [x] TASK-KIE-009 — Failure normalization
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-002
  - Owns: packages/providers/src/kie/errors/
  - Branch: task/TASK-KIE-009-kie-errors
  - Worktree: worktrees/TASK-KIE-009/
  - Acceptance: all Kie error shapes normalized to one error taxonomy (retryable/fatal/quota); no raw error leakage into logs with secrets; `npx vitest run packages/providers/src/kie/errors` green.
  - Status: MERGED

- [x] TASK-KIE-010 — Contract/smoke tests
  - Workflow: WF05
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: KIE-001, KIE-002, KIE-003, KIE-005
  - Owns: packages/providers/src/kie/__tests__/
  - Branch: task/TASK-KIE-010-kie-contract
  - Worktree: worktrees/TASK-KIE-010/
  - Acceptance: full mocked contract suite (submit/poll/resume/fail/archive handoff); optional live smoke gated behind credentials + $25 rule, skipped cleanly when absent; `npx vitest run packages/providers/src/kie/__tests__` green.
  - Status: MERGED

## WF06 — FISH AUDIO / AUDIO / CAPTIONS

- [x] TASK-FISH-001 — Fish Audio client
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, CORE-012
  - Owns: packages/providers/src/fish-audio/client/
  - Branch: task/TASK-FISH-001-fish-client
  - Worktree: worktrees/TASK-FISH-001/
  - Acceptance: HTTP client, auth from config, timeouts/retries, key never logged; current docs verified + recorded in docs/provider-capabilities/fish.md with URLs + date; s2.1-pro-free availability recorded but NOT assumed (config-driven model selection); `npx vitest run packages/providers/src/fish-audio/client` green (mocked).
  - Status: MERGED

- [x] TASK-FISH-002 — Voice profile management
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-001, CHAR-009
  - Owns: packages/providers/src/fish-audio/voice-profiles/
  - Branch: task/TASK-FISH-002-voice-profiles
  - Worktree: worktrees/TASK-FISH-002/
  - Acceptance: create/persist/list voice profiles per spec §16 fields; profile bound to character ID; test-sample status tracked; `npx vitest run packages/providers/src/fish-audio/voice-profiles` green.
  - Status: MERGED

- [ ] TASK-FISH-003 — TTS generation
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-002, CORE-007
  - Owns: packages/providers/src/fish-audio/tts/
  - Branch: task/TASK-FISH-003-tts
  - Worktree: worktrees/TASK-FISH-003/
  - Acceptance: dialogue → audio asset as separate durable asset (video replacement never forces voice regeneration); job record persisted before polling; mocked test returns asset with provider_task_id; `npx vitest run packages/providers/src/fish-audio/tts` green.
  - Status: BUILDER_DONE

- [x] TASK-FISH-004 — Pronunciation dictionary
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-002
  - Owns: packages/providers/src/fish-audio/pronunciation/
  - Branch: task/TASK-FISH-004-pronunciation
  - Worktree: worktrees/TASK-FISH-004/
  - Acceptance: per-character pronunciation dictionary + proper-noun list applied to TTS requests; dictionary versioned; `npx vitest run packages/providers/src/fish-audio/pronunciation` green.
  - Status: MERGED

- [x] TASK-FISH-005 — Dialogue cache
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-003, CORE-013
  - Owns: packages/providers/src/fish-audio/cache/
  - Branch: task/TASK-FISH-005-dialogue-cache
  - Worktree: worktrees/TASK-FISH-005/
  - Acceptance: same text+voice+model request returns cached asset (idempotency test); cache keyed by request hash; `npx vitest run packages/providers/src/fish-audio/cache` green.
  - Status: MERGED

- [ ] TASK-FISH-006 — Alignment/timestamps
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-003
  - Owns: packages/providers/src/fish-audio/alignment/
  - Branch: task/TASK-FISH-006-alignment
  - Worktree: worktrees/TASK-FISH-006/
  - Acceptance: word/phoneme timestamps extracted and persisted per dialogue asset; timestamp data feeds FISH-007; fixture test with known alignment; `npx vitest run packages/providers/src/fish-audio/alignment` green.
  - Status: BUILDER_DONE

- [ ] TASK-FISH-007 — Caption output
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-006
  - Owns: packages/providers/src/fish-audio/captions/
  - Branch: task/TASK-FISH-007-captions
  - Worktree: worktrees/TASK-FISH-007/
  - Acceptance: word-exact caption track generated from alignment (upstream gen_voice.py word-exact discipline); output format consumable by VID-004; `npx vitest run packages/providers/src/fish-audio/captions` green.
  - Status: BUILDER_DONE

- [x] TASK-FISH-008 — Audio normalization
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-001
  - Owns: packages/providers/src/fish-audio/normalize/
  - Branch: task/TASK-FISH-008-normalization
  - Worktree: worktrees/TASK-FISH-008/
  - Acceptance: FFmpeg loudness normalization contract (target LUFS configurable, deterministic args); probe-before/after; `npx vitest run packages/providers/src/fish-audio/normalize` green (fixture WAV; ffmpeg present per spec §2).
  - Status: MERGED

- [x] TASK-FISH-009 — Mix pipeline (dialogue/music/SFX)
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-008
  - Owns: packages/providers/src/fish-audio/mix/
  - Branch: task/TASK-FISH-009-mix
  - Worktree: worktrees/TASK-FISH-009/
  - Acceptance: dialogue + music bed + SFX mixed via FFmpeg with deterministic filter graph; mix plan as data; output passes ffprobe; `npx vitest run packages/providers/src/fish-audio/mix` green.
  - Status: MERGED

- [x] TASK-FISH-010 — Fish model/cost config
  - Workflow: WF06
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: FISH-001, CAP-006
  - Owns: packages/providers/src/fish-audio/config/
  - Branch: task/TASK-FISH-010-fish-config
  - Worktree: worktrees/TASK-FISH-010/
  - Acceptance: model selection + pricing fully config-driven (no hard-coded free assumption); cost estimate feeds CORE-009; `npx vitest run packages/providers/src/fish-audio/config` green.
  - Status: MERGED

## WF07 — GHL DURABLE MEDIA STORAGE

- [x] TASK-GHL-001 — GHL auth/config
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, CORE-012
  - Owns: packages/media-storage/src/ghl/auth/
  - Branch: task/TASK-GHL-001-ghl-auth
  - Worktree: worktrees/TASK-GHL-001/
  - Acceptance: bearer token + `Version: v3` header from config; token never logged (redaction test); current official docs verified + recorded in docs/provider-capabilities/ghl.md with URLs + date; `npx vitest run packages/media-storage/src/ghl/auth` green (mocked).
  - Status: MERGED

- [x] TASK-GHL-002 — List/search media
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-001
  - Owns: packages/media-storage/src/ghl/list/
  - Branch: task/TASK-GHL-002-ghl-list
  - Worktree: worktrees/TASK-GHL-002/
  - Acceptance: `GET /medias/files` with location context (altType=location, altId) lists/searches files + folders; pagination handled; folder-resolution by exact name (test: find "Convert and Flow"); `npx vitest run packages/media-storage/src/ghl/list` green.
  - Status: MERGED

- [x] TASK-GHL-003 — Create folder
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-001
  - Owns: packages/media-storage/src/ghl/folders/
  - Branch: task/TASK-GHL-003-ghl-create-folder
  - Worktree: worktrees/TASK-GHL-003/
  - Acceptance: `POST /medias/folder` {altId, altType:"location", name, parentId?}; returned folder ID persisted; search-before-create (duplicate-root prevention test); `npx vitest run packages/media-storage/src/ghl/folders` green.
  - Status: MERGED

- [x] TASK-GHL-004 — Idempotent Convert and Flow tree
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-002, GHL-003
  - Owns: packages/media-storage/src/ghl/tree/
  - Branch: task/TASK-GHL-004-ghl-tree
  - Worktree: worktrees/TASK-GHL-004/
  - Acceptance: full spec §17 tree (Convert and Flow / Character Library / Series / Standalone Movies + 01–09 episode subfolders) created idempotently; second run creates zero duplicates (test against mocked API recording calls); `npx vitest run packages/media-storage/src/ghl/tree` green.
  - Status: MERGED

- [x] TASK-GHL-005 — Hosted URL ingest
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-004
  - Owns: packages/media-storage/src/ghl/upload-hosted/
  - Branch: task/TASK-GHL-005-ghl-hosted
  - Worktree: worktrees/TASK-GHL-005/
  - Acceptance: `POST /medias/upload-file` multipart hosted=true + fileUrl + deterministic canonical name + parentId; returns fileId + storage URL stored; GHL URL reachability verified before ARCHIVED; `npx vitest run packages/media-storage/src/ghl/upload-hosted` green (mocked).
  - Status: MERGED

- [x] TASK-GHL-006 — Binary fallback upload
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-005
  - Owns: packages/media-storage/src/ghl/upload-binary/
  - Branch: task/TASK-GHL-006-ghl-binary
  - Worktree: worktrees/TASK-GHL-006/
  - Acceptance: hosted ingest failure → immediate download → checksum → ffprobe/decode verify → binary upload (25 MB general / 500 MB video limits enforced) → returned ID/URL verified → integrity compare before ARCHIVED; size-limit rejection test; `npx vitest run packages/media-storage/src/ghl/upload-binary` green.
  - Status: MERGED

- [x] TASK-GHL-007 — URL/file validation
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-001
  - Owns: packages/media-storage/src/ghl/validation/
  - Branch: task/TASK-GHL-007-ghl-validation
  - Worktree: worktrees/TASK-GHL-007/
  - Acceptance: remote download URL validation (spec §29: scheme allowlist, no SSRF to private ranges); MIME/file-type + file-size checks; path-traversal-safe filenames; `npx vitest run packages/media-storage/src/ghl/validation` green.
  - Status: MERGED

- [x] TASK-GHL-008 — Asset manifest integration
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-005, CORE-007
  - Owns: packages/media-storage/src/manifest/
  - Branch: task/TASK-GHL-008-asset-manifest
  - Worktree: worktrees/TASK-GHL-008/
  - Acceptance: MediaStore abstraction + GoHighLevelMediaStore implementation; asset record (spec §19 all 26 fields) written with ghl_file_id/ghl_folder_id/ghl_url/checksum; resolve-after-local-cache-removal test passes via DB; `npx vitest run packages/media-storage/src/manifest` green.
  - Status: MERGED

- [x] TASK-GHL-009 — Character canonical link persistence
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-008, CHAR-002
  - Owns: packages/media-storage/src/character-links/
  - Branch: task/TASK-GHL-009-character-links
  - Worktree: worktrees/TASK-GHL-009/
  - Acceptance: canonical character image → Character Library/<Name>/Identity Masters/ folder; GHL file ID + URL + folder ID + SHA-256 + generation metadata persisted on the character record (spec §9 exact fields); `npx vitest run packages/media-storage/src/character-links` green.
  - Status: MERGED

- [x] TASK-GHL-010 — Episode folder persistence
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-004, CORE-004
  - Owns: packages/media-storage/src/episode-folders/
  - Branch: task/TASK-GHL-010-episode-folders
  - Worktree: worktrees/TASK-GHL-010/
  - Acceptance: Series/<Name>/Season 01/S01E01 - <Title>/ created + all 9 subfolder IDs persisted; per-episode override respected; idempotent re-run test; `npx vitest run packages/media-storage/src/episode-folders` green.
  - Status: MERGED

- [x] TASK-GHL-011 — Retry/idempotency
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-005, CORE-013
  - Owns: packages/media-storage/src/ghl/retry/
  - Branch: task/TASK-GHL-011-ghl-retry
  - Worktree: worktrees/TASK-GHL-011/
  - Acceptance: bounded retry with backoff; retry never creates duplicate GHL files (idempotency-key test); archival never triggers regeneration (spec §17.5); `npx vitest run packages/media-storage/src/ghl/retry` green.
  - Status: MERGED

- [ ] TASK-GHL-012 — Provider temporary URL emergency archival
  - Workflow: WF07
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: GHL-005, GHL-006, CORE-007
  - Owns: packages/media-storage/src/emergency-archival/
  - Branch: task/TASK-GHL-012-emergency-archival
  - Worktree: worktrees/TASK-GHL-012/
  - Acceptance: restart at GENERATED_TEMPORARY archives the known provider URL immediately if valid (never regenerates); expired-URL path falls back to documented BLOCKED state, never silent regeneration; `npx vitest run packages/media-storage/src/emergency-archival` green.
  - Status: BUILDER_DONE

## WF08 — REMOTION / FFMPEG / RENDER

- [x] TASK-VID-001 — Preserve upstream shared kits + fix PF-1/PF-2
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-001
  - Owns: remotion/src/lib/, media/library/chess/ (SVG set), package fixes for PF-2
  - Branch: task/TASK-VID-001-preserve-kits
  - Worktree: worktrees/TASK-VID-001/
  - Acceptance: shared kits + registry generation (`npm run gen`) + frame-QA discipline preserved; PF-1 fixed (chess SVGs committed or chess.tsx inline — Short1Chess renders); PF-2 `npm audit fix` applied; `cd remotion && npm run gen && npx tsc --noEmit` passes; render smoke on previously-failing composition passes with `--scale=1`.
  - Status: MERGED

- [ ] TASK-VID-002 — Episodic composition registry
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-001, CORE-006
  - Owns: packages/remotion-runtime/src/registry/
  - Branch: task/TASK-VID-002-episodic-registry
  - Worktree: worktrees/TASK-VID-002/
  - Acceptance: episodic composition registry (series/episode/scene/shot → composition) generated from DB plan; `npm run gen` extended; registry test proves one composition per episode resolves; `npx vitest run packages/remotion-runtime/src/registry` green.
  - Status: BUILDER_DONE

- [x] TASK-VID-003 — Shot timeline abstraction
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-002
  - Owns: packages/remotion-runtime/src/timeline/
  - Branch: task/TASK-VID-003-shot-timeline
  - Worktree: worktrees/TASK-VID-003/
  - Acceptance: shot → timeline sequence mapping (sequence_index, in/out frames, fps); upstream frames.mjs local_f = global_s * fps − sequence_from convention preserved; unit test with known timings; `npx vitest run packages/remotion-runtime/src/timeline` green.
  - Status: MERGED

- [ ] TASK-VID-004 — Dialogue/captions layer
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003, FISH-007
  - Owns: packages/remotion-runtime/src/layers/captions/
  - Branch: task/TASK-VID-004-captions-layer
  - Worktree: worktrees/TASK-VID-004/
  - Acceptance: word-exact captions from FISH-007 alignment rendered in timeline; timing sync test (caption frame == alignment ms→frames); `npx vitest run packages/remotion-runtime/src/layers/captions` green.
  - Status: BUILDER_DONE

- [ ] TASK-VID-005 — Generated clip layer
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003, CORE-007
  - Owns: packages/remotion-runtime/src/layers/generated-clips/
  - Branch: task/TASK-VID-005-generated-clip-layer
  - Worktree: worktrees/TASK-VID-005/
  - Acceptance: archived provider clips (GHL-resolved assets) placed on timeline per shot plan; missing-asset error names the shot; mocked test assembles 3-shot sequence; `npx vitest run packages/remotion-runtime/src/layers/generated-clips` green.
  - Status: BUILDER_DONE

- [ ] TASK-VID-006 — Still-image motion layer
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003
  - Owns: packages/remotion-runtime/src/layers/still-motion/
  - Branch: task/TASK-VID-006-still-motion
  - Worktree: worktrees/TASK-VID-006/
  - Acceptance: AI stills animated with camera movement (pan/zoom/drift) per camera_motion spec field; deterministic rendering (same inputs → same frames, seeded); `npx vitest run packages/remotion-runtime/src/layers/still-motion` green.
  - Status: BUILDER_DONE

- [x] TASK-VID-007 — Stock/B-roll layer
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003
  - Owns: packages/remotion-runtime/src/layers/stock/
  - Branch: task/TASK-VID-007-stock-layer
  - Worktree: worktrees/TASK-VID-007/
  - Acceptance: stock/B-roll clips placed for generic establishing shots only; guard test rejects stock substitution for recurring main characters (spec §22); optional Pexels/Pixabay adapter interface stubbed; `npx vitest run packages/remotion-runtime/src/layers/stock` green.
  - Status: MERGED

- [ ] TASK-VID-008 — Native graphics layer
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003
  - Owns: packages/remotion-runtime/src/layers/graphics/
  - Branch: task/TASK-VID-008-graphics-layer
  - Worktree: worktrees/TASK-VID-008/
  - Acceptance: native Remotion graphics (titles, overlays, credits, lower thirds) composable per shot plan; `npx vitest run packages/remotion-runtime/src/layers/graphics` green.
  - Status: BUILDER_DONE

- [ ] TASK-VID-009 — Transitions
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003
  - Owns: packages/remotion-runtime/src/transitions/
  - Branch: task/TASK-VID-009-transitions
  - Worktree: worktrees/TASK-VID-009/
  - Acceptance: transition catalog (cut, crossfade, wipe minimum) applied at shot boundaries from plan data; frame-exact overlap math tested; `npx vitest run packages/remotion-runtime/src/transitions` green.
  - Status: BUILDER_DONE

- [ ] TASK-VID-010 — Audio/music/SFX timeline
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-003, FISH-009
  - Owns: packages/remotion-runtime/src/layers/audio/
  - Branch: task/TASK-VID-010-audio-timeline
  - Worktree: worktrees/TASK-VID-010/
  - Acceptance: dialogue + music + SFX placed on audio timeline from mix plan; loop-friendly (frame-0==last-frame convention preserved); sync test; `npx vitest run packages/remotion-runtime/src/layers/audio` green.
  - Status: BUILDER_DONE

- [x] TASK-VID-011 — Aspect ratios
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-002
  - Owns: packages/remotion-runtime/src/aspect/
  - Branch: task/TASK-VID-011-aspect
  - Worktree: worktrees/TASK-VID-011/
  - Acceptance: 16:9 and 9:16 compositions both generate from the same plan; series-level default + per-episode override; resolution/safe-area math tested; `npx vitest run packages/remotion-runtime/src/aspect` green.
  - Status: MERGED

- [x] TASK-VID-012 — Rough cut assembly
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-002, VID-003, VID-004, VID-005, VID-006, VID-007, VID-008, VID-009, VID-010, VID-011
  - Owns: packages/remotion-runtime/src/rough-cut/
  - Branch: task/TASK-VID-012-rough-cut
  - Worktree: worktrees/TASK-VID-012/
  - Acceptance: full episode assembles from shot plan + archived assets; `mmcs rough-cut` wired; 16:9 AND 9:16 rough cuts render (acceptance §32) on fixture project; `npx vitest run packages/remotion-runtime/src/rough-cut` green.
  - Status: MERGED

- [ ] TASK-VID-013 — Selective shot replacement
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-012
  - Owns: packages/remotion-runtime/src/shot-replacement/
  - Branch: task/TASK-VID-013-shot-replacement
  - Worktree: worktrees/TASK-VID-013/
  - Acceptance: replace one shot (new asset/trim) without regenerating unaffected shots — composition diff test proves only the targeted shot's inputs change; `mmcs retry-shot <id>` wired; `npx vitest run packages/remotion-runtime/src/shot-replacement` green.
  - Status: BUILDER_DONE

- [ ] TASK-VID-014 — Final render pipeline
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-002, VID-003, VID-012
  - Owns: packages/remotion-runtime/src/final-render/
  - Branch: task/TASK-VID-014-final-render
  - Worktree: worktrees/TASK-VID-014/
  - Acceptance: approved rough cut → final render at series/episode resolution; 720p-source upscale never labeled native 1080p (metadata flag test); `mmcs final` wired; fixture final render completes and passes VID-015 ffprobe; `npx vitest run packages/remotion-runtime/src/final-render` green.
  - Status: BUILDER_DONE

- [x] TASK-VID-015 — ffprobe integrity checks
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-001
  - Owns: packages/remotion-runtime/src/ffprobe/
  - Branch: task/TASK-VID-015-ffprobe
  - Worktree: worktrees/TASK-VID-015/
  - Acceptance: ffprobe wrapper reports codec/duration/resolution/bitrate; integrity check fails on corrupted fixture (truncated file test); every render output validated before ARCHIVED; `npx vitest run packages/remotion-runtime/src/ffprobe` green.
  - Status: MERGED

- [ ] TASK-VID-016 — Video frame extraction for QC
  - Workflow: WF08
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: VID-015
  - Owns: packages/remotion-runtime/src/frame-extraction/
  - Branch: task/TASK-VID-016-frame-extraction
  - Worktree: worktrees/TASK-VID-016/
  - Acceptance: representative frames extracted from any generated clip for image-vision QC (spec §20 fallback path); frame count/timestamps configurable; upstream frames.mjs discipline reused; `npx vitest run packages/remotion-runtime/src/frame-extraction` green.
  - Status: BUILDER_DONE

## WF09B — QC / ROUTING (QC-* live in WF09)

- [ ] TASK-QC-001 — Per-shot visual QC schema
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CAP-002
  - Owns: packages/qc/src/schema/
  - Branch: task/TASK-QC-001-qc-schema
  - Worktree: worktrees/TASK-QC-001/
  - Acceptance: QC result schema covers all spec §20 checks (identity, face consistency, skin tone, hair, wardrobe, accessories, anatomy, props, location, lighting continuity, camera, action, artifacts, lip/face, start/end state, neighbor continuity, dialogue suitability); verdict + evidence fields versioned; `npx vitest run packages/qc/src/schema` green.
  - Status: BUILDER_DONE

- [ ] TASK-QC-002 — Character identity comparison
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-001
  - Owns: packages/qc/src/identity/
  - Branch: task/TASK-QC-002-identity-check
  - Worktree: worktrees/TASK-QC-002/
  - Acceptance: extracted frame vs canonical identity asset comparison via vision-model interface (registry-selected); mismatch verdict on doctored fixture; `npx vitest run packages/qc/src/identity` green (mocked vision model).
  - Status: BUILDER_DONE

- [x] TASK-QC-003 — Wardrobe/hair/prop checks
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-001
  - Owns: packages/qc/src/wardrobe/
  - Branch: task/TASK-QC-003-wardrobe-check
  - Worktree: worktrees/TASK-QC-003/
  - Acceptance: active appearance version (hair/wardrobe/props) verified against shot spec requirements; wrong-wardrobe fixture flagged; `npx vitest run packages/qc/src/wardrobe` green.
  - Status: MERGED

- [x] TASK-QC-004 — Continuity neighbor check
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-001
  - Owns: packages/qc/src/continuity/
  - Branch: task/TASK-QC-004-continuity
  - Worktree: worktrees/TASK-QC-004/
  - Acceptance: neighboring shots compared against each other + current Series Bible state (spec §11); continuity-break fixture flagged; `npx vitest run packages/qc/src/continuity` green.
  - Status: MERGED

- [ ] TASK-QC-005 — Video direct vs extracted-frame route
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-001, CAP-007, VID-016
  - Owns: packages/qc/src/route/
  - Branch: task/TASK-QC-005-qc-route
  - Worktree: worktrees/TASK-QC-005/
  - Acceptance: video-capable model → direct video review; otherwise FFmpeg frame extraction → image-vision QC; route selection from capability profile (both branches tested); `npx vitest run packages/qc/src/route` green.
  - Status: BUILDER_DONE

- [x] TASK-QC-006 — Retry policy
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-001, CORE-009
  - Owns: packages/qc/src/retry/
  - Branch: task/TASK-QC-006-retry-policy
  - Worktree: worktrees/TASK-QC-006/
  - Acceptance: targeted repair of affected shot only — never whole-episode regeneration (test proves single-shot scope); retry bounded by cost policy; `npx vitest run packages/qc/src/retry` green.
  - Status: MERGED

- [ ] TASK-QC-007 — Agnes Flash acceptance route
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-006, AGN-006
  - Owns: packages/qc/src/routes/agnes-flash/
  - Branch: task/TASK-QC-007-agnes-flash-route
  - Worktree: worktrees/TASK-QC-007/
  - Acceptance: Flash PASS kept as FINAL footage (never auto-discarded as preview-only); likely prompt/seed failure → one Flash retry; `npx vitest run packages/qc/src/routes/agnes-flash` green.
  - Status: BUILDER_DONE

- [x] TASK-QC-008 — Agnes regular fallback
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-007, AGN-007
  - Owns: packages/qc/src/routes/agnes-regular/
  - Branch: task/TASK-QC-008-agnes-regular-fallback
  - Worktree: worktrees/TASK-QC-008/
  - Acceptance: Flash FAIL after retry → Agnes Video 2.5 regular escalation; fallback trigger conditions tested; `npx vitest run packages/qc/src/routes/agnes-regular` green.
  - Status: MERGED

- [x] TASK-QC-009 — Seedance fallback
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-008, KIE-003
  - Owns: packages/qc/src/routes/seedance/
  - Branch: task/TASK-QC-009-seedance-fallback
  - Worktree: worktrees/TASK-QC-009/
  - Acceptance: reference/identity problem persists after Agnes regular → Seedance 2.0 Mini escalation; mode constraints honored on fallback requests; `npx vitest run packages/qc/src/routes/seedance` green.
  - Status: MERGED

- [x] TASK-QC-010 — Wan hero/complex fallback
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-009, KIE-005
  - Owns: packages/qc/src/routes/wan/
  - Branch: task/TASK-QC-010-wan-fallback
  - Worktree: worktrees/TASK-QC-010/
  - Acceptance: especially complex/long/hero/action shots route to Wan 3.0; routing policy considers capability/quality-history/cost/quota (policy table test); `npx vitest run packages/qc/src/routes/wan` green.
  - Status: MERGED

- [ ] TASK-QC-011 — Human REVIEW state
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-008, QC-006
  - Owns: packages/qc/src/human-review/
  - Branch: task/TASK-QC-011-human-review
  - Worktree: worktrees/TASK-QC-011/
  - Acceptance: automated routes exhausted → shot enters persisted human REVIEW state; no silent auto-approval; `mmcs qc` surfaces REVIEW items; `npx vitest run packages/qc/src/human-review` green.
  - Status: BLOCKED

- [x] TASK-QC-012 — Final episode QC
  - Workflow: WF09
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: QC-004, QC-005, VID-012
  - Owns: packages/qc/src/final-episode/
  - Branch: task/TASK-QC-012-final-episode-qc
  - Worktree: worktrees/TASK-QC-012/
  - Acceptance: full-episode QC runs before rough-cut presentation; production report data collected (runtime, aspect/resolution, providers/models, generated/accepted/rejected seconds, retries, cost, quota, characters, canon changes, final URL, QC status — spec §21); `npx vitest run packages/qc/src/final-episode` green.
  - Status: MERGED

## WF10 — SKILLS / RECOVERY / INTEGRATION / RELEASE

- [ ] TASK-SKL-001 — Canonical portable Skill
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-011, CORE-008, CORE-009
  - Owns: skills/mini-movie-creator/ (SKILL.md, references/workflow.md, references/approvals.md, references/providers.md, references/recovery.md, scripts/mmcs-status.sh)
  - Branch: task/TASK-SKL-001-canonical-skill
  - Worktree: worktrees/TASK-SKL-001/
  - Acceptance: AgentSkills-style SKILL.md concise frontmatter; all 25 required behaviors of spec §27 teachable; references hold detail; no secrets/hard-coded credentials (secret-scan grep clean); `bash skills/mini-movie-creator/scripts/mmcs-status.sh` exits 0 against a stub state; SKILL.md ≤ 500 lines.
  - Status: PASS

- [x] TASK-SKL-002 — Claude project install
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-001
  - Owns: .claude/skills/mini-movie-creator (symlink or copy+sync), integrations/claude/project-install.sh
  - Branch: task/TASK-SKL-002-claude-project-install
  - Worktree: worktrees/TASK-SKL-002/
  - Acceptance: `.claude/skills/mini-movie-creator` resolves to canonical source; `claude` loads it; non-destructive dry run of `/mini-movie-creator status` documented; install script idempotent (second run no-op); `bash integrations/claude/project-install.sh --check` exits 0.
  - Status: MERGED

- [ ] TASK-SKL-003 — Claude personal install
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-002
  - Owns: integrations/claude/personal-install.sh, $HOME/.claude/skills/mini-movie-creator (symlink)
  - Branch: task/TASK-SKL-003-personal-install
  - Worktree: worktrees/TASK-SKL-003/
  - Acceptance: backup-before-overwrite logic (existing personal skill never destroyed without backup/confirmation); symlink to canonical source; verified in NEW session outside repo; documented skill-discovery root; `bash integrations/claude/personal-install.sh --check` exits 0.
  - Status: BUILDER_DONE

- [x] TASK-SKL-004 — Claude-nine verification
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-003
  - Owns: docs/environment/CLAUDE-NINE-CAPABILITIES.md (update), integrations/claude/nine-verify.sh
  - Branch: task/TASK-SKL-004-nine-verify
  - Worktree: worktrees/TASK-SKL-004/
  - Acceptance: fresh claude-nine session invokes `/mini-movie-creator status` with same engine/state (no copied logic); actual skill discovery root (~/.claude-nine/skills/ primary + sync from ~/.claude/skills/) documented; verified behavior recorded, never invented; `bash integrations/claude/nine-verify.sh` exits 0.
  - Status: MERGED

- [x] TASK-SKL-005 — OpenClaw workspace install
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-001
  - Owns: integrations/openclaw/mini-movie-creator/ (packaging), integrations/openclaw/install.sh
  - Branch: task/TASK-SKL-005-openclaw-workspace
  - Worktree: worktrees/TASK-SKL-005/
  - Acceptance: packaging at integrations/openclaw/mini-movie-creator/ (SKILL.md + references/scripts, calls same CLI/DB — no engine fork); active workspace resolved from OpenClaw config (never guessed); install via current `openclaw skills install` flow or workspace placement; `openclaw skills list` shows mini-movie-creator.
  - Status: MERGED

- [x] TASK-SKL-006 — OpenClaw global optional install
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-005
  - Owns: integrations/openclaw/global-install.sh
  - Branch: task/TASK-SKL-006-openclaw-global
  - Worktree: worktrees/TASK-SKL-006/
  - Acceptance: optional global install form documented + tested; workspace install remains the supported default; uninstall/rollback path verified; `bash integrations/openclaw/global-install.sh --check` exits 0.
  - Status: MERGED

- [x] TASK-SKL-007 — OpenClaw invocation test
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: SKL-005
  - Owns: integrations/openclaw/invocation-test.sh, docs/openclaw-skill-verification.md
  - Branch: task/TASK-SKL-007-openclaw-invocation
  - Worktree: worktrees/TASK-SKL-007/
  - Acceptance: explicit invocation from an OpenClaw agent reaches the same mmcs engine + project state; skill watcher pickup verified (not assumed); `openclaw skills check` passes; test evidence recorded in docs/openclaw-skill-verification.md.
  - Status: MERGED

- [x] TASK-REC-001 — Checkpoint service wiring
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-014
  - Owns: state/ writers, scripts/orchestration/checkpoint.*
  - Branch: task/TASK-REC-001-checkpoint-wiring
  - Worktree: worktrees/TASK-REC-001/
  - Acceptance: checkpoint cadence enforced (every material transition, before/after compaction, before/after batch merge, session end, every watchdog cycle — spec §28); atomic write verified under concurrent writers; `npx vitest run packages/core/src/recovery` + integration script exit 0.
  - Status: MERGED

- [ ] TASK-REC-002 — PreCompact hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/pre-compact.sh, .claude/settings.json (PreCompact wiring)
  - Branch: task/TASK-REC-002-precompact
  - Worktree: worktrees/TASK-REC-002/
  - Acceptance: save-first-compact-second: reads hook JSON from stdin; checkpoint lock; session.md + checkpoint.json updated; ledger PRECOMPACT_CHECKPOINT appended; exits 0 after flush; executable bit set; simulated hook invocation test passes.
  - Status: READY

- [ ] TASK-REC-003 — PostCompact hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/post-compact.sh, .claude/settings.json (PostCompact wiring)
  - Branch: task/TASK-REC-003-postcompact
  - Worktree: worktrees/TASK-REC-003/
  - Acceptance: records event; updates recovery marker; never treats compact summary as sole project state; simulated invocation test passes.
  - Status: READY

- [ ] TASK-REC-004 — SessionStart hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/session-start.sh, .claude/settings.json (SessionStart wiring)
  - Branch: task/TASK-REC-004-session-start
  - Worktree: worktrees/TASK-REC-004/
  - Acceptance: injects recovery context (orchestrator-only reminder; recovery.md/checkpoint.json/todo.md/ledger-tail pointers); reconcile instruction vs duplicate prevention (never duplicate ACTIVE/PASS/MERGED); recreates the two /loop skills when absent; simulated invocation test passes.
  - Status: READY

- [ ] TASK-REC-005 — SessionEnd hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/session-end.sh, .claude/settings.json (SessionEnd wiring)
  - Branch: task/TASK-REC-005-session-end
  - Worktree: worktrees/TASK-REC-005/
  - Acceptance: final checkpoint + exact resume command/state written to recovery.md; simulated invocation test passes.
  - Status: READY

- [ ] TASK-REC-006 — TaskCompleted hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/task-completed.sh, .claude/settings.json (TaskCompleted wiring)
  - Branch: task/TASK-REC-006-task-completed
  - Worktree: worktrees/TASK-REC-006/
  - Acceptance: exit 2 blocks premature close when acceptance/QC evidence missing (task not in state/tasks.json; no test evidence; no QC PASS; ACTIVE→MERGED jump; branch/worktree unrecorded); feedback message names exactly what remains; gate test with missing evidence exits 2, with evidence exits 0.
  - Status: READY

- [ ] TASK-REC-007 — TeammateIdle hook
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001
  - Owns: .claude/hooks/teammate-idle.sh, .claude/settings.json (TeammateIdle wiring)
  - Branch: task/TASK-REC-007-teammate-idle
  - Worktree: worktrees/TASK-REC-007/
  - Acceptance: exit 2 + continue instruction when teammate owns ACTIVE/QC_FIXING task; directs to claim next compatible READY task in same workflow; allows idle when no useful work; both-branch tests pass.
  - Status: READY

- [ ] TASK-REC-008 — Watchdog Skill/loop
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001, CORE-011
  - Owns: .claude/skills/mmcs-watchdog/SKILL.md, scripts/orchestration/watchdog.*
  - Branch: task/TASK-REC-008-watchdog
  - Worktree: worktrees/TASK-REC-008/
  - Acceptance: watchdog implements runbook §7.1 checks (locks state/locks/watchdog.lock; verifies workflows/agents/worktrees vs recorded; enforces 10/500; refills under-capacity IMMEDIATELY — never merely reports; pings stalled; kills duplicates; ensures BUILDER_DONE has Sonnet QC; pushes PASS to queue; updates build-status.md + ledger + atomic checkpoint); `--selftest` with an artificially underfilled workflow detects + flags refill; `npx vitest run scripts/orchestration/watchdog.test.ts` green.
  - Status: BUILDER_DONE

- [x] TASK-REC-009 — Batch merge Skill/loop
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-001, CORE-011
  - Owns: .claude/skills/mmcs-batch-merge/SKILL.md, scripts/orchestration/batch-merge.*
  - Branch: task/TASK-REC-009-batch-merge
  - Worktree: worktrees/TASK-REC-009/
  - Acceptance: implements runbook §7.2 (locks state/locks/merge.lock; admits only Sonnet-QC-PASS with passing tests; orders by dependency/conflict risk; batch-merges to integration in dedicated merge workflow; affected-area regression + secret scan before push; no QC PASS = no merge); dry-run mode test on fixture queue; `npx vitest run scripts/orchestration/batch-merge.test.ts` green.
  - Status: MERGED

- [x] TASK-REC-010 — Restart simulation
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-002, REC-003, REC-004, REC-005, REC-008, REC-009
  - Owns: scripts/orchestration/restart-sim.*, docs/recovery-simulation.md
  - Branch: task/TASK-REC-010-restart-sim
  - Worktree: worktrees/TASK-REC-010/
  - Acceptance: simulated stop/restart recovers active task map WITHOUT duplicate task creation; worktree/branch reconciliation matches recorded state; kill provider polling after submission → resume polls existing task ID (no resubmit — spec §32 recovery acceptance); simulation script exits 0.
  - Status: MERGED

- [ ] TASK-REC-011 — Auto-compact simulation
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REC-002, REC-003
  - Owns: scripts/orchestration/compact-sim.*, docs/compact-simulation.md
  - Branch: task/TASK-REC-011-compact-sim
  - Worktree: worktrees/TASK-REC-011/
  - Acceptance: manual /compact (simulated PreCompact→PostCompact) updates checkpoint; simulated new/resumed session injects + reads state; no data loss across compaction; simulation script exits 0.
  - Status: READY

- [ ] TASK-REL-001 — Clean install
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: CORE-002, CORE-010, CORE-011, CORE-015, SKL-002, SKL-005
  - Owns: scripts/release/clean-install.sh, docs/installation.md
  - Branch: task/TASK-REL-001-clean-install
  - Worktree: worktrees/TASK-REL-001/
  - Acceptance: fresh clean clone → install → `mmcs doctor` exits 0; no secrets required for doctor; docs/installation.md covers prerequisites + .env configuration; script exits 0 on a pristine clone.
  - Status: BLOCKED

- [ ] TASK-REL-002 — Full regression
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REL-001
  - Owns: scripts/release/regression.sh
  - Branch: task/TASK-REL-002-full-regression
  - Worktree: worktrees/TASK-REL-002/
  - Acceptance: full vitest suite + `npm run gen` + `npx tsc --noEmit` + lint + Remotion render smoke (16:9 + 9:16) + ffprobe availability check all pass in one scripted run; script exits 0 with per-area summary.
  - Status: BLOCKED

- [ ] TASK-REL-003 — Example project
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REL-001
  - Owns: examples/demo-series/, docs/first-series.md
  - Branch: task/TASK-REL-003-example-project
  - Worktree: worktrees/TASK-REL-003/
  - Acceptance: example series + episode seed (fixtures, no paid generation) loads via `mmcs create-series`/`create-episode` and exercises the non-paid pipeline steps; docs/first-series.md walkthrough verified step-by-step; `npx vitest run examples/demo-series` green.
  - Status: BLOCKED

- [ ] TASK-REL-004 — End-to-end dry run
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REL-002, REL-003, CHAR-005, DIR-003, DIR-008, DIR-015, VID-012, GHL-008, QC-011
  - Owns: scripts/release/e2e-dry-run.sh, docs/e2e-dry-run-report.md
  - Branch: task/TASK-REL-004-e2e-dry-run
  - Worktree: worktrees/TASK-REL-004/
  - Acceptance: controlled short sample project exercises concept → script → character candidate selection → storyboard → (mocked paid generation where credentials absent) → GHL archival → Remotion assembly → QC → rough cut → final render → restart/resume simulation; every defect found fixed before PASS; report written; script exits 0.
  - Status: BLOCKED

- [ ] TASK-REL-005 — Minimal provider smoke run
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REL-004, AGN-004, KIE-002, FISH-003, GHL-005, CORE-009
  - Owns: scripts/release/provider-smoke.sh, docs/provider-smoke-report.md
  - Branch: task/TASK-REL-005-provider-smoke
  - Worktree: worktrees/TASK-REL-005/
  - Acceptance: minimal paid smoke (≥1 Agnes generation; ≥1 Kie call if credentials/cost permit; Fish Audio; GHL archival) with cost controls + $25 gate enforced; credential-absent providers mocked and marked BLOCKED — never falsely passed (spec §30); report records spend + job IDs.
  - Status: BLOCKED

- [ ] TASK-REL-006 — Release docs + final merge
  - Workflow: WF10
  - Builder: unassigned
  - QC/Fixer: unassigned
  - Depends on: REL-002, REL-003, REL-004, REL-005, SKL-003, SKL-004, SKL-006, SKL-007, REC-010, REC-011
  - Owns: docs/ (all deliverables in spec §33), README.md, session.md (final), release tag
  - Branch: task/TASK-REL-006-release-docs
  - Worktree: worktrees/TASK-REL-006/
  - Acceptance: spec §33 doc list complete (installation, prerequisites, .env, first series, character library, approvals, provider setup, GHL setup, three skill installs, cost controls, capability registry, adding a provider, troubleshooting, recovery, standalone path); integration promoted to main after full regression; annotated release tag pushed; final session.md tells the user exactly how to launch/use MMCS; docs lint/verify script exits 0.
  - Status: BLOCKED

<!-- WF10-END -->

---

## Counts by workflow

| Workflow | Tasks | READY | BLOCKED |
|---|---|---|---|
| WF01 CORE | 15 | 8 | 7 |
| WF02 CHAR | 15 | 13 | 2 |
| WF03 DIR | 15 | 12 | 3 |
| WF09A CAP | 10 | 10 | 0 |
| WF04 AGN | 10 | 10 | 0 |
| WF05 KIE | 10 | 10 | 0 |
| WF06 FISH | 10 | 10 | 0 |
| WF07 GHL | 12 | 12 | 0 |
| WF08 VID | 16 | 16 | 0 |
| WF09B QC | 12 | 11 | 1 |
| WF10 SKL+REC+REL | 24 | 18 | 6 |
| **Total** | **149** | **130** | **19** |

## Dependency unlock notes

- CORE-003 merge unblocks CORE-004/005/006/007 immediately; CORE-004 merge unblocks CORE-008; CORE-007 + CORE-008 unblock CORE-009; all five schema merges unblock CORE-015.
- CORE-008 merge unblocks CHAR-005, CHAR-013, DIR-003, DIR-008, DIR-015, QC-011 immediately.
- All other dependencies are contract-first (interface per spec.md); builders build against the spec contract in wave 1 and bind to merged implementations as dependencies land. Unlock dependents the moment a dependency hits MERGED — never wait for a wave boundary (runbook §10).
- REL-* is wave-3 release state by design (runbook §10 wave 3).