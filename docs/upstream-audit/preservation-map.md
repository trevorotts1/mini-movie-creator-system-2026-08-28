# Upstream Preservation Map — CORE-001

**Project:** mini-movie-creator-system (MMCS)
**Task:** CORE-001 — audit upstream packages/scripts + preservation map
**Date:** 2026-08-28
**Upstream base:** hassancs91/claude-faceless-shorts-creator @ `773054bebbe460de0f31dcfda5315970b1c8b4f2` (2026-08-18), MIT, attribution preserved forever (spec §2)
**Sources:** docs/BASELINE-REPORT.md (WF00 validation, live render smoke), `git ls-files` of the production tree, live worktree inspection. Every path below was verified to exist in the tree on 2026-08-28 unless marked otherwise.

Disposition vocabulary:

- **keep** — carried into MMCS as-is (content preserved; may gain MMCS-side consumers).
- **keep (scope: inherited-tools)** — kept and functional, but demoted from "engine of record" to "inherited tooling" for one concern; MMCS supersedes it with a spec §1 package.
- **rewrite** — evolved in place by an owned MMCS task (content intent preserved, implementation replaced/extended).
- **drop** — removed or not carried forward, with reason.
- **superseded** — replaced by an MMCS artifact that already exists in the scaffold.

Nothing upstream is dropped for taste. Drops require a reason tied to a spec fact.

---

## 1. Repo-level files

| Upstream path | Disposition | Reason / owner |
|---|---|---|
| `LICENSE` (MIT) | **keep** | Spec §2: attribution preserved forever. |
| `CLAUDE.md` | **keep** | Repo doctrine (3 tracks, conventions, hard rules). Evolved only by MMCS conventions additions; never deleted. |
| `README.md` | **rewrite** | User-facing guide becomes MMCS docs per spec §33; upstream example index retained as history in docs. |
| `brand.md` | **keep** | Style contract every skill reads (palette, motion, safe areas, SFX taste). Reused as MMCS visual-style default input (spec §62). |
| `IDEAS.md` | **keep** | Idea bank + niche ranking; content asset. |
| `.env.example` | **rewrite** | Spec §26: add MMCS names (`AGNES_API_KEY`, `KIE_API_KEY`, `FISH_API_KEY`, `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `OPENROUTER_API_KEY`, `NINEROUTER_URL`, `NINEROUTER_KEY`); upstream `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `FAL_KEY` entries STAY for the inherited Python tools. |
| `.gitignore` | **keep** | Already ignores `.env`, `node_modules`, `remotion/out/`, `*/voice/`, `*/output/`, AI-clip working copies — matches spec §2 facts. MMCS appends only. |
| root `package-lock.json` (upstream stub) | **superseded** | Upstream name-only stub lockfile; MMCS scaffold (CORE-002) replaced with pnpm workspace + root `package.json`. Recorded, not a deletion of hand-written content. |

## 2. Skills (`.claude/skills/`, 5)

All five operate on the inherited three-track backbone and stay working. The canonical MMCS skill is a NEW skill (`skills/mini-movie-creator/`, spec §27) — it never forks these.

| Skill | Disposition | Reason |
|---|---|---|
| `make-short` | **keep** | 100%-TSX track; six-beat grammar + frame-QA pipeline remain the reference workflow (spec §21 preserves the six-beat grammar concepts). |
| `make-ai-short` | **keep** | Locked-character doctrine + cost-before-spend + loop-by-constraint map directly to spec §9/§4/§8. fal-centric mechanics stay as the inherited track; MMCS provider adapters (Agnes/Kie) are additive, not replacements. |
| `make-vox` | **keep** | Collage track; CollageBoard/cutout machinery kept intact. |
| `vidtsx-2d-generator` | **keep** | The TSX crash-prevention contract (frame-based animation, monotonic interpolate, Easing.bezier). Adopted wholesale as MMCS composition rules. |
| `suggest-sfx` | **keep** | sfx-plan.json machinery, user-audit gate, RMS verification kept (spec §2 lists `sfx-plan.json` as a machine contract). |

## 3. Python tools (`tools/`, 11)

Spec §26 explicitly keeps the inherited Python tools (their env keys stay in `.env.example`). None are dropped. Roles vs MMCS packages:

| Tool | Disposition | Reason / MMCS counterpart |
|---|---|---|
| `gen_voice.py` | **keep (scope: inherited-tools)** | Word-exact TTS timing is the caption gold standard (word times written back to beats.json). MMCS dialogue voice = Fish Audio adapter (`packages/providers`, spec §16); ElevenLabs route remains for inherited shorts. |
| `gen_sfx.py` | **keep** | ElevenLabs SFX generation into `media/library/sfx/` with catalog + `used_in` — the library-first pattern MMCS keeps. |
| `gen_music.py` | **keep** | Music bed generation; same catalog discipline. |
| `gen_image.py` | **keep (scope: inherited-tools)** | Gemini image gen with presets. MMCS image path = capability-profile-driven adapters (spec §15; Agnes Image preferred path). Tool stays for the vox/story-image track. |
| `gen_clip.py` | **keep (scope: inherited-tools)** | fal.ai queue client (model-agnostic). MMCS video = Agnes/Kie adapters (spec §5/§26). Tool remains for ai-shorts track + as an adapter-pattern reference. |
| `bakeoff_clip.py` | **keep** | Multi-model clip comparison harness — directly reusable for §13 router policy evaluation. |
| `mix_sfx.py` | **keep** | Declarative sfx-plan.json → ducked mix + RMS verification + `--print` audit artifact. Kept whole (spec §21: FFmpeg owns mixing; this tool drives ffmpeg correctly). |
| `mix_music.py` | **keep** | Music bed audition/mix. |
| `gen_chords.py` | **keep** | Chord progressions for music beds. |
| `cutout.py` | **keep** | rembg die-cuts for collage layers (optional extras: pillow+rembg). |
| `capture_web.py` | **keep** | Playwright HTML→PNG for collage layers (optional extras: playwright+chromium). |

## 4. Remotion scripts (`remotion/scripts/`, 3)

| Script | Disposition | Reason |
|---|---|---|
| `gen-registry.mjs` | **keep** | Spec §2/§21: registry generation (`cd remotion && npm run gen`) is a preserved build-equivalent check. |
| `frames.mjs` | **keep** | Spec §21 preserves the frame-QA discipline verbatim (dump frames, READ every PNG, `local_f = global_s * fps − sequence_from`). |
| `render-all.mjs` | **keep** | Spec §2 fact preserved: **scale 2 default — pass `--scale=1` for native**. Episodic rendering (VID-012/014) drives it through `packages/remotion-runtime`. |

## 5. Remotion source (`remotion/src/`)

| Item | Disposition | Reason |
|---|---|---|
| `index.ts`, `Root.tsx` | **keep** | Entry points; registry-driven. |
| `registry.gen.tsx`, `shots.manifest.json` | **keep (generated)** | Regenerated by `npm run gen`; never hand-edited. |
| `brand.ts`, `fonts.ts` | **keep** | Shared brand constants consumed by every kit. |
| `lib/shorts.tsx` | **keep** | Shared backbone kit — the single most reused upstream file. |
| `lib/collage.tsx` | **keep** | Collage kit (CollageBoard camera, parallax, cutouts, chips, routes). |
| `lib/chess.tsx` | **keep — carries PF-1 fix** | Renders only after the missing SVG set exists (see §8 PF-1). Fix owned by VID-001: commit `media/library/chess/<code>.svg` set (12 pieces) or swap to inline SVG — spec §2 names both options; SVG-set chosen (zero code churn, restores upstream content intent). |
| `lib/math.tsx`, `algo.tsx`, `sheet.tsx`, `piano.tsx`, `prob.tsx`, `map.tsx`, `orbit.tsx`, `chart.tsx`, `story.tsx`, `terminal.tsx`, `browser.tsx`, `kit.tsx`, `geo/world.ts` | **keep** (13 kits) | Niche kits are working, smoke-tested code (13/14 render PASS). §21: preserve the upstream shared kits. |
| `shots/` — 14 comps: `short-1`…`short-12` (Chess, Math, Algo, Reflog/Git, Prob/Monty, Sheet, Kids, Phish, Chords, Fees, Map, Orbit), `ai-1` (Door), `vox-1` (Coffee) | **keep** | Reference corpus at 1080x1920@30. 13/14 frame-QA PASS; Short1Chess blocked only by PF-1. MMCS adds episodic compositions alongside (VID-002); upstream shots remain untouched regression fixtures (spec §30 Remotion render smoke). |

## 6. Project corpora + media

| Item | Disposition | Reason |
|---|---|---|
| `shorts/` (12 projects: script.md + beats.json + sfx-plan.json) | **keep** | Working examples + fixtures for beats.json contract tests. |
| `ai-shorts/blue-man/` (+ `IDEAS.md`) | **keep** | character.json locked-reference exemplar (spec §9 precursor); committed paid clips. |
| `vox-shorts/` (`DESIGN.md` + vox-1-coffee) | **keep** | Collage visual language; read-before-work contract. |
| `media/library/` (sfx 33 clips + catalog + palette; music 6 clips + catalog + palette; logos) | **keep** | Cross-video reusable assets with catalogs + `used_in` — the reuse-before-generate doctrine (spec §2). |
| `media/projects/` (blue-man, short-7-kids, vox-1-coffee) | **keep** | Committed paid pixels (non-reproducible); one-video asset separation preserved. |
| `media/library/chess/` | **MISSING upstream — MMCS must ADD** | This absence IS PF-1. See §8. |

## 7. Data contracts + manifests

| Item | Disposition | Reason |
|---|---|---|
| `beats.json` (per project) | **keep** | Spec §2: machine contract. Drives composition, captions, voice timing, SFX cues, cost ledger. |
| `character.json` (ai-shorts) | **keep** | Spec §2: machine contract; the locked-character doctrine record. Evolves toward §9 canonical identity assets (GHL-linked) — the JSON shape stays as the local cache form. |
| `sfx-plan.json` (per project) | **keep** | Spec §2: machine contract; consumed by `mix_sfx.py`. |
| `media/library/{sfx,music}/{catalog.json,palette.json}` | **keep** | Catalog + `used_in` tracking. |
| `remotion/package.json` | **keep** | Upstream fact: no `test` script, no `build`, no `engines`. Build-equivalent = `npm run gen` + `npx tsc --noEmit` (spec §30). MMCS adds its test framework at the monorepo root (vitest), NOT inside `remotion/`. |
| `remotion/remotion.config.ts`, `tsconfig.json` | **keep** | publicDir `../media`, strict TS — preserved untouched (ARCHITECTURE.md rule 5). |
| `pnpm-workspace.yaml` + root `package.json` (MMCS scaffold) | **superseded (already MMCS)** | CORE-002 delivered; listed for completeness of the layout reconciliation. |

## 8. Pre-existing failures carried forward (spec §2 facts)

### PF-1 — Short1Chess cannot render: 12 chess piece SVGs missing

- `remotion/src/lib/chess.tsx:213` references `staticFile('library/chess/<code>.svg')` for `bR bB bQ bK bP bN wR wB wQ wK wP wN`.
- `media/library/chess/` never existed upstream (confirmed against git history — never added, never deleted).
- Symptom: 404 → `EncodingError: The source image cannot be decoded.` → frames dump exits 1, no PNG.
- **Carried forward as:** MMCS fix REQUIRED, owned by VID-001 (preserve/audit upstream Remotion). Disposition decided: commit a standard 12-piece SVG set at `media/library/chess/<code>.svg` (preferred: restores assets without touching `chess.tsx`); inline-SVG swap is the fallback. Until fixed, Short1Chess stays the single known render failure — 13/14 smoke PASS remains the upstream truth.

### PF-2 — npm audit: 3 high-severity vulnerabilities (fix available, not applied)

- `fast-uri` 3.0.0–3.1.4 (GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7)
- `nanoid` ≤3.3.17 (GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8)
- `postcss` ≤8.5.22 (GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849)
- All transitive; install succeeds. **Carried forward as:** run `npm audit fix` inside `remotion/` after the baseline pin, per spec §2 sequencing (fix is scheduled, not dropped; baseline stays pristine until the pin lands).

### PF-3 (cosmetic) — `npm warn deprecated source-map@0.8.0-beta.0`

- No functional impact. Carried forward as a known-noise note; no action.

## 9. Reconciliation against spec §2 (verified facts — build on, do not redo)

| Spec §2 fact | Audit finding | Status |
|---|---|---|
| Remotion 4.0.486 | All `@remotion/*` + core at 4.0.486; `npx remotion versions` consistent across 19 packages | MATCH |
| 14 compositions `1080x1920@30` | Registry reports 14 comps, all 1080x1920@30 (34–55s) | MATCH |
| 13/14 render smoke PASS | 13 PASS; only Short1Chess fails (PF-1, asset gap, not code) | MATCH |
| Data contracts `beats.json`, `character.json`, `sfx-plan.json` | All present, schemas documented in BASELINE-REPORT §5 | MATCH |
| Registry generated by `cd remotion && npm run gen` | `gen-registry.mjs` scans `shots/**/*.tsx` | MATCH |
| Frame-QA `scripts/frames.mjs <Id> <frames> --scale=0.5` | Present; READ-every-PNG checklist in make-short | MATCH |
| `render-all.mjs` scale 2 default | Confirmed in script + BASELINE-REPORT §11 | MATCH |
| `media/` = publicDir; `media/library/` vs `media/projects/<proj>/` split; committed paid pixels; `*/voice/`, `*/output/`, `remotion/out/` gitignored | Confirmed in tree + `.gitignore` + `remotion.config.ts` | MATCH |
| No upstream test script/framework | Confirmed: no test script, no framework, no test files | MATCH |
| PF-1 / PF-2 | Reproduced and carried forward (§8) | MATCH |

No contradictions found between the upstream audit and spec §2. No spec deviation logged.

## 10. Upstream concept → MMCS package mapping (spec §1 ↔ ARCHITECTURE.md)

| Upstream concept | MMCS home |
|---|---|
| `beats.json` timeline/voice/SFX/cost contract | `packages/scene-intelligence` + `packages/remotion-runtime` input contracts |
| `character.json` locked-character doctrine | `packages/character-library` (§9 canonical identity assets, GHL linkage) |
| `sfx-plan.json` + `mix_sfx.py` | audio tooling kept; surfaced through `packages/qc` verification + audio pipeline |
| Frame-QA discipline (`frames.mjs`) | `packages/qc` (VID-016 frame extraction; QC-005 route) |
| Registry generation (`gen-registry.mjs`) | `packages/remotion-runtime` bridge; `remotion/` stays untouched |
| Cost-before-spend + `costs_usd` ledger | `packages/cost-engine` (§4 $25 cumulative atomic rule) |
| Library-first media catalogs + `used_in` | `packages/media-storage` (MediaStore abstraction; GHL durable archive §17) |
| Locked-character + `--ref` doctrine | `packages/character-library` + `packages/providers` reference planning (§8) |
| vidtsx hard rules | composition authoring contract inside `packages/remotion-runtime` |
| Six-beat grammar | episodic beat grammar in `packages/scene-intelligence` (§7) |

## 11. Explicit drop list

**None.** No upstream package, script, tool, skill, composition, contract, or media asset is dropped. The only non-keep dispositions are:

1. upstream stub root `package-lock.json` — **superseded** by the MMCS pnpm scaffold (CORE-002);
2. scope demotions (§3: `gen_voice.py`, `gen_image.py`, `gen_clip.py`) — tools kept functional, but ElevenLabs/Gemini/fal are no longer the engine-of-record providers for MMCS production (engine voice = Fish Audio §16; video = Agnes/Kie §5; image = capability-registry-selected §15). Inherited tracks keep working unchanged.

## 12. Validation

`node docs/upstream-audit/validate.mjs` — asserts this map exists, is non-empty, carries PF-1 and PF-2, covers the full inventory counts (11 tools, 3 remotion scripts, 5 skills, 14 compositions, 16 lib kits), and that every inventory row carries a keep|rewrite|drop|keep-with-scope|superseded disposition. Acceptance command: `test -s docs/upstream-audit/preservation-map.md && grep -q "PF-1" docs/upstream-audit/preservation-map.md`.