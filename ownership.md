# ownership.md — MMCS Path-Ownership Map (authoritative)

Prevents write collisions across the ~149-task parallel build (runbook §24 task
decomposition, spec.md §1 package layout). This file is **the** authority on who may
write which path. Runbook §8 binds it: *"ownership.md is authoritative for shared
files: serialize, split behind interface, assign integration owner, or redesign."*

## 1. RULES

1. **Two active builders never own the same implementation file.** If a task is not
   listed as an owner of a path, that task must not create or edit it.
2. **This file is authoritative.** A path conflict is resolved by this table, not by
   whoever writes first. Disputes go to the orchestrator; the fix is recorded here
   before either builder proceeds.
3. **Builder + paired QC/fixer share one task branch/worktree** (`worktrees/<TASK-ID>/`,
   branch `task/TASK-<ID>-<slug>` off `origin/integration`) and are treated as ONE
   owner. Never two unrelated builders in one worktree.
4. **Shared-file protocol** — when two tasks genuinely need one file, pick one and
   record it in the table:
   - **SERIALIZE** — only one task may write the file, ever; others request changes
     through it (used for manifests, lockfiles, root configs).
   - **SPLIT BEHIND INTERFACE** — each task owns its own file; cross-task calls go
     through a published interface (types/base class) owned by the framework task.
     Used for package barrels, validators, layer files.
   - **DEDICATED INTEGRATION TASK** — one named task (or the batch-merge integration
     owner) is the only writer; all other tasks deliver fragments/notes to it.
5. **Directories, not files, wherever possible.** A task owning a directory owns
   everything under it unless another row carves out a subpath.
6. **Package barrel files (`packages/*/src/index.ts`)** are integration-owned: no task
   edits a barrel directly; exports are wired by the integration task at batch merge.
   Exception: capability-registry (fragment assembler, see §2).
7. **Read-only is always allowed.** Owning nothing never blocks importing another
   package's public API.
8. **Worktree hygiene:** each task works only inside its own worktree; node_modules
   per worktree is expected but monitor disk (runbook: ~30 GiB free).

## 2. SHARED-CONTENTION FILES — EXPLICIT PROTOCOLS

| Path | Protocol | Owner / rule |
|---|---|---|
| `package.json` (workspace root) | SERIALIZE | Integration-task only. No build task edits root manifest; deps go in the owning package's own `package.json`. |
| `pnpm-lock.yaml` / `package-lock.json` | SERIALIZE | Integration-task only. Lockfile regenerates at batch merge, never mid-wave by a builder. |
| `packages/capability-registry/src/registry.ts` | SPLIT (fragment-based) | No provider task writes the index. Each provider family owns its own fragment file: `src/fragments/agnes.ts` (AGN-001), `src/fragments/kie.ts` (KIE-001), `src/fragments/fish-audio.ts` (FISH-001), overrides in `src/fragments/overrides.ts` (CAP-010). **CAP-010 is the sole assembler** and owns `src/registry.ts` + the barrel. |
| `packages/database/src/migrations/` | SPLIT (numbered bands) | CORE-003 owns the migration framework/runner + baseline band `000_–009_`. Band assignments: CORE-004 → `010_–019_`, CORE-005 → `020_–029_`, CORE-006 → `030_–039_`, CORE-007 → `040_–049_`. One migration directory per task inside its band (`010_project_series_episode/` etc.). Never edit another band. |
| `tsconfig*.json` / `tsconfig/base` config | SERIALIZE | CORE-002 owns all root/base TypeScript config. Every other task is read-only (path alias requests go to CORE-002 or the integration task). |
| `.env.example` | SERIALIZE | CAP-009 (provider health/verify) owns it. Tasks needing a new key open a note to CAP-009; never edit directly. `.env` itself is gitignored and never committed. |
| `spec.md` | SERIALIZE | Orchestrator-approved changes only. Builders never edit requirements; deviations go to `decisions.md`. |
| `todo.md`, `ledger.md`, `state/*.json` | APPEND-ONLY | Workflow-operational agents append status lines / state snapshots only. Never rewrite history, never delete another agent's lines. Same discipline for `qc.md`, `checklist.md`, `session.md`, `recovery.md`, `task-graph.md`, `integration-queue.md`, `build-status.md`. |
| `.claude/settings.json` (hook registration) | SERIALIZE | REC-001 owns hook registration entries; each REC-002..007 task owns only its own hook script under `scripts/hooks/<event>.ts`. |
| `apps/cli/src/` | SPLIT | CORE-011 owns the CLI scaffold (`apps/cli/src/index.ts`, dispatcher). Each command-owning task adds one file under `apps/cli/src/commands/<group>.ts`; the dispatcher wires it at integration. |
| `remotion/` (upstream project) | SPLIT | VID-001 owns the audit/preservation pass and `remotion/src/lib/` shared kits. VID-002 owns the episodic composition registry under `remotion/src/episodic/`. Upstream shots (`remotion/src/shots/`) are read-only reference; PF-1 chess fix lands via VID-001. |
| `packages/core/src/approvals/` | SPLIT | CORE-008 owns the approval state machine. QC-011 (human REVIEW state) owns `packages/qc/src/human-review.ts` and consumes the core approvals API read-only — it does not edit `packages/core/`. |
| `docs/`, `README.md` | SERIALIZE | REL-006 owns release docs + README. CORE-001 owns `docs/audit/` + `PRESERVATION-MAP.md`. Provider capability docs: CAP-002 owns `docs/provider-capabilities/`. |
| `BASELINE-REPORT.md`, `LICENSE` | SERIALIZE | Read-only after WF00 bootstrap. LICENSE preserved forever (fork attribution). |

## 3. PER-TASK OWNERSHIP TABLE

149 tasks (runbook §24). State is `READY` until the orchestrator flips it in
`todo.md`. "Shared notes" column carries the §2 protocol bindings that apply.

### WF01 — CORE / STATE / DATABASE

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| CORE-001 | `docs/audit/`, `PRESERVATION-MAP.md` | Audit + preservation map; no code | READY |
| CORE-002 | `pnpm-workspace.yaml`, `tsconfig*.json`, root scaffold dirs (`packages/`, `apps/`, `integrations/`) | Owns all tsconfig; others read-only. Root `package.json` still integration-only | READY |
| CORE-003 | `packages/database/src/` (connection, migration framework, repository base), `packages/database/src/migrations/000_–009_` | Owns migration runner; bands 010+ owned by CORE-004..007 | READY |
| CORE-004 | `packages/database/src/migrations/010_–019_`, `packages/database/src/repositories/project-series-episode.ts` | Migration band 010_–019_ only | READY |
| CORE-005 | `packages/database/src/migrations/020_–029_`, `packages/database/src/repositories/character-location-appearance.ts` | Migration band 020_–029_ only | READY |
| CORE-006 | `packages/database/src/migrations/030_–039_`, `packages/database/src/repositories/scene-shot-reference.ts` | Migration band 030_–039_ only | READY |
| CORE-007 | `packages/database/src/migrations/040_–049_`, `packages/database/src/repositories/provider-job-asset.ts` | Migration band 040_–049_ only | READY |
| CORE-008 | `packages/core/src/approvals/` | QC-011 consumes read-only, never edits | READY |
| CORE-009 | `packages/cost-engine/src/reservations.ts`, `packages/cost-engine/src/ledger.ts` | CAP-006, AGN-009, KIE-007, FISH-010 consume via interface | READY |
| CORE-010 | `packages/core/src/config/` | Reads `.env.example` (CAP-009-owned), never edits it | READY |
| CORE-011 | `apps/cli/src/index.ts`, `apps/cli/src/dispatch/` | Owns CLI scaffold; command files owned by their feature tasks | READY |
| CORE-012 | `packages/core/src/logging/` | — | READY |
| CORE-013 | `packages/core/src/idempotency/` | Consumed by AGN-010, KIE-002, GHL-011, FISH-005 via interface | READY |
| CORE-014 | `packages/core/src/checkpoint/` | Implementation owner; REC-001 owns wiring/integration glue only | READY |
| CORE-015 | `packages/database/src/backup/`, `scripts/backup/` | — | READY |

### WF02 — CHARACTER / SERIES

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| CHAR-001 | `packages/character-library/src/identity/` | Package lead; barrel wiring requests only | READY |
| CHAR-002 | `packages/character-library/src/canonical/` | — | READY |
| CHAR-003 | `packages/character-library/src/candidates/` | — | READY |
| CHAR-004 | `packages/character-library/src/cli-contract/`, `apps/cli/src/commands/character.ts` | CLI dispatcher (CORE-011) wires command file at integration | READY |
| CHAR-005 | `packages/character-library/src/locking/` | — | READY |
| CHAR-006 | `packages/character-library/src/appearance/` | — | READY |
| CHAR-007 | `packages/character-library/src/wardrobe/` | — | READY |
| CHAR-008 | `packages/character-library/src/hair/` | — | READY |
| CHAR-009 | `packages/character-library/src/voice-binding/` | Fish interface read-only (FISH-002 owns provider side) | READY |
| CHAR-010 | `packages/character-library/src/cast/` | — | READY |
| CHAR-011 | `packages/character-library/src/locations/` | — | READY |
| CHAR-012 | `packages/character-library/src/bible/` | — | READY |
| CHAR-013 | `packages/character-library/src/canon/` | Uses CORE-008 approvals API read-only | READY |
| CHAR-014 | `packages/character-library/src/ghl-links/` | MediaStore interface read-only (GHL lane owns impl) | READY |
| CHAR-015 | `packages/character-library/src/reference-metrics/` | — | READY |

### WF03 — WRITING / DIRECTING (scene-intelligence)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| DIR-001 | `packages/scene-intelligence/src/intake/` | Package lead; barrel wiring requests only | READY |
| DIR-002 | `packages/scene-intelligence/src/concept/generator.ts` | — | READY |
| DIR-003 | `packages/scene-intelligence/src/approvals/concept.ts` | One file per task in `approvals/`; no shared edits | READY |
| DIR-004 | `packages/scene-intelligence/src/screenplay/` | — | READY |
| DIR-005 | `packages/scene-intelligence/src/runtime-estimator/` | — | READY |
| DIR-006 | `packages/scene-intelligence/src/script-critic/` | — | READY |
| DIR-007 | `packages/scene-intelligence/src/script-revision/` | — | READY |
| DIR-008 | `packages/scene-intelligence/src/approvals/script.ts` | One file per task in `approvals/` | READY |
| DIR-009 | `packages/scene-intelligence/src/scene-parser/` | — | READY |
| DIR-010 | `packages/scene-intelligence/src/shot-planner/` | — | READY |
| DIR-011 | `packages/scene-intelligence/src/scene-master/` | — | READY |
| DIR-012 | `packages/scene-intelligence/src/keyframe-planner/` | — | READY |
| DIR-013 | `packages/scene-intelligence/src/reference-budget/` | ReferenceBudgetPlanner | READY |
| DIR-014 | `packages/scene-intelligence/src/storyboard/` | — | READY |
| DIR-015 | `packages/scene-intelligence/src/approvals/storyboard.ts` | One file per task in `approvals/` | READY |

### WF09a — PROVIDERS / CAPABILITIES (capability-registry)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| CAP-001 | `packages/capability-registry/src/schema.ts` | Schema foundation; all registry tasks consume read-only | READY |
| CAP-002 | `packages/capability-registry/src/confidence.ts`, `docs/provider-capabilities/` | Owns capability docs dir; source/date confidence rules | READY |
| CAP-003 | `packages/capability-registry/src/validators/character-count.ts` | One file per task in `validators/` | READY |
| CAP-004 | `packages/capability-registry/src/validators/reference-count.ts` | One file per task in `validators/` | READY |
| CAP-005 | `packages/capability-registry/src/validators/exclusive-modes.ts` | One file per task in `validators/` | READY |
| CAP-006 | `packages/capability-registry/src/pricing.ts` | Writes cost-engine via CORE-009 interface only | READY |
| CAP-007 | `packages/capability-registry/src/reasoning-registry.ts` | — | READY |
| CAP-008 | `packages/capability-registry/src/max-reasoning.ts` | Consumes CAP-007 read-only | READY |
| CAP-009 | `packages/capability-registry/src/health.ts`, `.env.example`, `apps/cli/src/commands/verify.ts` | Sole owner of `.env.example` | READY |
| CAP-010 | `packages/capability-registry/src/registry.ts`, `packages/capability-registry/src/fragments/overrides.ts`, `packages/capability-registry/src/index.ts` | Sole assembler/index owner; fragments land from AGN-001/KIE-001/FISH-001 | READY |

### WF04 — AGNES (providers/agnes)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| AGN-001 | `packages/providers/src/agnes/client.ts`, `packages/capability-registry/src/fragments/agnes.ts` | Family lead; fragment file only, never `registry.ts` | READY |
| AGN-002 | `packages/providers/src/agnes/image.ts` | — | READY |
| AGN-003 | `packages/providers/src/agnes/image-edit.ts` | Gated on live-API support check | READY |
| AGN-004 | `packages/providers/src/agnes/video-submit.ts` | — | READY |
| AGN-005 | `packages/providers/src/agnes/video-poll.ts` | Idempotency via CORE-013 interface | READY |
| AGN-006 | `packages/providers/src/agnes/profiles/flash.ts` | One file per task in `profiles/` | READY |
| AGN-007 | `packages/providers/src/agnes/profiles/regular.ts` | One file per task in `profiles/` | READY |
| AGN-008 | `packages/providers/src/agnes/validation.ts` | — | READY |
| AGN-009 | `packages/providers/src/agnes/quota.ts` | Cost-engine writes via CORE-009 interface | READY |
| AGN-010 | `packages/providers/src/agnes/retry.ts` | Uses CORE-013 primitives | READY |

### WF05 — KIE / SEEDANCE / WAN (providers/kie)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| KIE-001 | `packages/providers/src/kie/client.ts`, `packages/capability-registry/src/fragments/kie.ts` | Family lead; fragment file only, never `registry.ts` | READY |
| KIE-002 | `packages/providers/src/kie/tasks.ts` | Generic submit/poll abstraction | READY |
| KIE-003 | `packages/providers/src/kie/profiles/seedance-mini.ts` | One file per task in `profiles/` | READY |
| KIE-004 | `packages/providers/src/kie/profiles/seedance-modes.ts` | One file per task in `profiles/` | READY |
| KIE-005 | `packages/providers/src/kie/profiles/wan.ts` | One file per task in `profiles/` | READY |
| KIE-006 | `packages/providers/src/kie/profiles/wan-validation.ts` | Wan 3.0: 20k-char prompt, ≤10 refs, multimodal-ref exclusivity | READY |
| KIE-007 | `packages/providers/src/kie/cost.ts` | Cost-engine writes via CORE-009 interface | READY |
| KIE-008 | `packages/providers/src/kie/temp-url.ts` | Archival handoff to GHL-012 | READY |
| KIE-009 | `packages/providers/src/kie/errors.ts` | Failure normalization | READY |
| KIE-010 | `packages/providers/test/kie/` | Contract/smoke tests only; no src edits | READY |

### WF06 — FISH AUDIO (providers/fish-audio)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| FISH-001 | `packages/providers/src/fish-audio/client.ts`, `packages/capability-registry/src/fragments/fish-audio.ts` | Family lead; fragment file only, never `registry.ts` | READY |
| FISH-002 | `packages/providers/src/fish-audio/voice-profile.ts` | Consumed read-only by CHAR-009 | READY |
| FISH-003 | `packages/providers/src/fish-audio/tts.ts` | — | READY |
| FISH-004 | `packages/providers/src/fish-audio/pronunciation.ts` | — | READY |
| FISH-005 | `packages/providers/src/fish-audio/dialogue-cache.ts` | Idempotency via CORE-013 | READY |
| FISH-006 | `packages/providers/src/fish-audio/alignment.ts` | — | READY |
| FISH-007 | `packages/providers/src/fish-audio/captions.ts` | — | READY |
| FISH-008 | `packages/providers/src/fish-audio/normalize.ts` | FFmpeg contract | READY |
| FISH-009 | `packages/providers/src/fish-audio/mix.ts` | — | READY |
| FISH-010 | `packages/providers/src/fish-audio/config.ts` | Model/cost config via CAP-006/CORE-009 interfaces | READY |

### WF07 — GHL DURABLE MEDIA STORAGE (media-storage)

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| GHL-001 | `packages/media-storage/src/ghl/auth.ts`, `packages/media-storage/src/ghl/config.ts` | Family lead | READY |
| GHL-002 | `packages/media-storage/src/ghl/list.ts` | — | READY |
| GHL-003 | `packages/media-storage/src/ghl/folders.ts` | — | READY |
| GHL-004 | `packages/media-storage/src/ghl/tree.ts` | Idempotent Convert and Flow hierarchy | READY |
| GHL-005 | `packages/media-storage/src/ghl/ingest-url.ts` | — | READY |
| GHL-006 | `packages/media-storage/src/ghl/upload.ts` | Binary fallback, 25 MB / 500 MB video limits | READY |
| GHL-007 | `packages/media-storage/src/ghl/validate.ts` | — | READY |
| GHL-008 | `packages/media-storage/src/manifest.ts` | Asset manifest/provenance integration | READY |
| GHL-009 | `packages/media-storage/src/links/character.ts` | — | READY |
| GHL-010 | `packages/media-storage/src/links/episode.ts` | — | READY |
| GHL-011 | `packages/media-storage/src/ghl/retry.ts` | Idempotency via CORE-013 | READY |
| GHL-012 | `packages/media-storage/src/ghl/emergency-archive.ts` | Provider temp-URL emergency archival; handoff from KIE-008 | READY |

### WF08 — REMOTION / FFMPEG / RENDER

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| VID-001 | `remotion/src/lib/`, PF-1 chess fix | Owns upstream preservation/audit; upstream shots read-only | READY |
| VID-002 | `remotion/src/episodic/` | Episodic composition registry; registry gen via `cd remotion && npm run gen` | READY |
| VID-003 | `packages/remotion-runtime/src/timeline/` | Package lead; barrel wiring requests only | READY |
| VID-004 | `packages/remotion-runtime/src/layers/dialogue.tsx` | One file per task in `layers/` | READY |
| VID-005 | `packages/remotion-runtime/src/layers/ai-video.tsx` | One file per task in `layers/` | READY |
| VID-006 | `packages/remotion-runtime/src/layers/still-motion.tsx` | One file per task in `layers/` | READY |
| VID-007 | `packages/remotion-runtime/src/layers/stock.tsx` | One file per task in `layers/` | READY |
| VID-008 | `packages/remotion-runtime/src/layers/graphics.tsx` | One file per task in `layers/` | READY |
| VID-009 | `packages/remotion-runtime/src/layers/transitions.tsx` | One file per task in `layers/` | READY |
| VID-010 | `packages/remotion-runtime/src/audio-timeline/` | Music/SFX timeline | READY |
| VID-011 | `packages/remotion-runtime/src/aspect/` | Aspect ratios | READY |
| VID-012 | `packages/remotion-runtime/src/render/rough-cut.ts` | One file per task in `render/` | READY |
| VID-013 | `packages/remotion-runtime/src/render/shot-replace.ts` | One file per task in `render/` | READY |
| VID-014 | `packages/remotion-runtime/src/render/final.ts` | One file per task in `render/`; `--scale=1` for native | READY |
| VID-015 | `packages/remotion-runtime/src/validate/ffprobe.ts` | — | READY |
| VID-016 | `packages/remotion-runtime/src/validate/frames.ts` | Frame extraction consumed read-only by QC lane | READY |

### WF09b — QC / ROUTING

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| QC-001 | `packages/qc/src/schema.ts` | Package lead; barrel wiring requests only | READY |
| QC-002 | `packages/qc/src/checks/identity.ts` | One file per task in `checks/` | READY |
| QC-003 | `packages/qc/src/checks/wardrobe.ts` | One file per task in `checks/` | READY |
| QC-004 | `packages/qc/src/checks/continuity.ts` | One file per task in `checks/` | READY |
| QC-005 | `packages/qc/src/routing/frame-route.ts` | Direct-vs-extracted-frame route | READY |
| QC-006 | `packages/qc/src/retry.ts` | — | READY |
| QC-007 | `packages/qc/src/routes/agnes-flash.ts` | One file per task in `routes/` | READY |
| QC-008 | `packages/qc/src/routes/agnes-regular.ts` | One file per task in `routes/` | READY |
| QC-009 | `packages/qc/src/routes/seedance.ts` | One file per task in `routes/` | READY |
| QC-010 | `packages/qc/src/routes/wan.ts` | One file per task in `routes/` | READY |
| QC-011 | `packages/qc/src/human-review.ts` | Consumes CORE-008 approvals read-only; never edits `packages/core/` | READY |
| QC-012 | `packages/qc/src/final-episode.ts` | — | READY |

### WF10a — SKILLS / INSTALL TARGETS

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| SKL-001 | `skills/mini-movie-creator/` | Canonical skill source; REC-008/009 loop sections added only by coordinated edit | READY |
| SKL-002 | `integrations/claude/project-install/` | Installs from SKL-001 source, never edits it | READY |
| SKL-003 | `integrations/claude/personal-install/` | Installs from SKL-001 source, never edits it | READY |
| SKL-004 | `integrations/claude/verify/` | — | READY |
| SKL-005 | `integrations/openclaw/workspace-install/` | — | READY |
| SKL-006 | `integrations/openclaw/global-install/` | — | READY |
| SKL-007 | `integrations/openclaw/verify/` | — | READY |

### WF10b — RECOVERY / HOOKS

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| REC-001 | `scripts/recovery/`, `.claude/settings.json` (hook registration), `state/` writers | Wiring owner; checkpoint implementation is CORE-014's | READY |
| REC-002 | `scripts/hooks/pre-compact.ts` | One hook file per task; registration via REC-001 | READY |
| REC-003 | `scripts/hooks/post-compact.ts` | One hook file per task | READY |
| REC-004 | `scripts/hooks/session-start.ts` | One hook file per task | READY |
| REC-005 | `scripts/hooks/session-end.ts` | One hook file per task | READY |
| REC-006 | `scripts/hooks/task-completed.ts` | One hook file per task | READY |
| REC-007 | `scripts/hooks/teammate-idle.ts` | One hook file per task | READY |
| REC-008 | `scripts/watchdog/` | Skill-section edits to SKL-001 only by coordinated edit | READY |
| REC-009 | `scripts/batch-merge/` | Merge loop; also the SERIALIZE writer for root `package.json`/lockfiles at merge time | READY |
| REC-010 | `scripts/tests/restart-sim/` | — | READY |
| REC-011 | `scripts/tests/compact-sim/` | — | READY |

### WF10c — RELEASE

| Task ID | Owned paths | Shared/serialized notes | State |
|---|---|---|---|
| REL-001 | `scripts/release/clean-install.sh` | — | READY |
| REL-002 | `scripts/release/regression.sh` | — | READY |
| REL-003 | `examples/` | — | READY |
| REL-004 | `scripts/release/e2e-dry-run.sh` | — | READY |
| REL-005 | `scripts/release/provider-smoke.sh` | — | READY |
| REL-006 | `docs/release/`, `README.md` | Sole owner of README + release docs | READY |

## 4. CHANGE CONTROL

- Ownership changes are made by editing this file first, then `todo.md` — never the
  reverse. Every change names the two tasks involved and the protocol applied.
- A task discovering it needs a path it does not own: STOP, record the request in
  `ledger.md` (`OWNERSHIP-REQUEST | TASK-ID | path`), and wait for the orchestrator
  to update this file. Silent path grabs are merge-queue rejects.
- Unowned paths (not in any row) default to the integration task (REC-009 batch
  merger) — claim them here before writing.