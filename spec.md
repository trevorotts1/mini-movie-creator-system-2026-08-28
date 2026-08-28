# MMCS Specification (spec.md)

**Project:** mini-movie-creator-system (MMCS)
**Status:** PENDING — populated by planning workflow
**Upstream base:** hassancs91/claude-faceless-shorts-creator (MIT preserved)
**Created:** 2026-08-28

This file is the single source of truth for what MMCS must become. The planning
workflow will replace the status line above and fill each subsystem section below
with binding requirements. Until then the skeletons below name every required
subsystem and its responsibility in one line.

---

## Subsystem skeletons

### 1. Approval gates (6)
Six human approval checkpoints in the production pipeline (spec → storyboard →
assets → assembly → QC → publish); nothing advances past a gate without explicit
operator sign-off.

### 2. Capability registry
Central registry of every provider/model capability (image, video, TTS, music)
with live availability, cost per unit, and rate limits — the single lookup the
router and budget systems consult.

### 3. Prompt budget manager
Owns per-phase prompt/token budgets; every agent prompt is composed here so no
phase can overspend its allocation.

### 4. Reference budget planner
Allocates reference-image/reference-material budgets per scene and per character
so consistency work never exceeds its spend ceiling.

### 5. Keyframe / scene-master planner
Decides keyframes, scene masters, and shot boundaries for each video before any
generation call is made.

### 6. Video router
Routes each shot's video-generation request to the best available video provider
from the capability registry, honoring budget and approval state.

### 7. Image registry
Registry of every generated/stored image asset with provenance (provider, prompt,
model, cost) so any shot can be traced and regenerated deterministically.

### 8. Fish Audio integration
Voice/TTS subsystem backed by Fish Audio: character voice assignment, synthesis
jobs, and per-word timing where available.

### 9. GHL MediaStore integration
Storage/publishing bridge to GHL MediaStore for finished assets and final videos.

### 10. Asset manifest
Single manifest of every asset (image, audio, video, font, template) with IDs,
paths, hashes, and generation metadata — the contract between planners and builders.

### 11. SQLite database
Local SQLite store for tasks, costs, approvals, asset metadata, and run history;
file-backed, migration-managed, no external DB dependency.

### 12. Async job safety
All long-running generation jobs are async with persisted job records, retry
semantics, idempotency keys, and crash-safe resume.

### 13. Automated QC
Automated quality checks (visual, audio, subtitle sync, duration, cost ceilings)
run on every artifact before human gates.

### 14. Remotion / FFmpeg pipeline
Deterministic rendering: Remotion composes shots to video; FFmpeg handles
transcode, mux, and subtitle burn-in.

### 15. Cost engine ($25 rule)
Every run carries a hard $25 ceiling; the cost engine tracks spend per task and
blocks generation that would exceed the ceiling.

### 16. Character library
Persistent library of characters with locked visual/voice definitions so series
consistency survives across episodes.

### 17. Series bible
Canon store: series premise, episode outlines, running plot state, and continuity
facts every planner must obey.

### 18. Locations / wardrobe / props
Consistency registries for locations, wardrobe, and props with reference assets
and reuse rules.

### 19. Skills (Claude Code + claude-nine + OpenClaw)
Agent skill definitions targeting all three runtimes so the same workflow
specification executes identically regardless of host.

### 20. Standalone-app readiness
The system must run as a standalone app: no dependency on any one agent session
being alive; state survives restarts (see recovery.md).

### 21. Security baseline
Secrets never in repo or logs; per-provider keys via env; media pipeline input
validation; no client credentials in operator space.

---

## Non-goals (initial)

- No client messaging or publishing automation until approval gate 6 exists.
- No multi-tenant features; single operator (Trevor) only.

---

*Planning workflow owns the next revision of this file.*