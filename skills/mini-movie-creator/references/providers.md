# MMCS Providers Reference — capabilities, routing, validation, skill packaging

The capability registry is the single source of truth for every model limit.
Never hard-code model constants in prompts, adapters, or this skill.

## Capability registry

One centralized, versioned, machine-readable registry; separate registries
for reasoning/vision LLMs, image models, video models, voice models, and
storage providers. Media model profiles carry:

- `provider`, `modelId`, `kind` (image | video)
- `lastVerifiedAt`, `sourceUrls`, `confidence` (`VERIFIED` | `PROVISIONAL` | `UNKNOWN`)
- `prompt.hardMaxCharacters` / `prompt.recommendedMaxCharacters` / `negativePrompt`
- `references.maxImages` / `maxVideos` / `maxAudio`, `firstFrame`,
  `lastFrame`, `firstLastFrame`, `multimodalReferences`,
  `incompatibleCombinations`
- `output` durations/resolutions/aspect ratios; `pricing` unit/amount/currency

Every value carries provenance. **UNKNOWN is a valid, first-class value** —
never invent a number to replace UNKNOWN (e.g. never invent an Agnes hard
prompt ceiling because another model has one). Runtime-observed overrides
may refine profiles but never silently rewrite a VERIFIED value on one
transient failure — `mmcs providers verify` reports configured vs
documented vs runtime-observed capability plus last-verified dates and
discrepancy warnings.

CLI:

```bash
mmcs providers            # configured providers
mmcs providers verify     # capability verification report
mmcs models               # models per provider
```

## Pre-request validation order (all providers, every request)

1. Resolve capability profile
2. Compile model-specific prompt
3. Count prompt characters exactly
4. Compare against hard max when known
5. Compress semantically if over — never truncate mid-instruction; preserve
   highest-priority information (priority order: character identity-critical
   detail → action → continuity-critical wardrobe/props → location →
   start/end state → camera framing → camera motion → lighting → visual
   style → secondary atmosphere)
6. Validate reference counts
7. Validate mutually exclusive modes
8. Validate duration/resolution
9. Estimate spend/quota and take the atomic budget reservation
10. Only then submit

## Video providers & routing policy

Initial adapters (never hard-coded branches; new models slot in without
engine redesign): **Agnes Video 2.5 Flash**, **Agnes Video 2.5 regular**,
**Kie.ai Seedance 2.0 Mini**, **Kie.ai Wan 3.0**. Planning baselines
(verify current official docs at implementation time; the registry, not this
file, is authoritative): Agnes 720p, 4–12s, up to 5 reference images,
first/last-frame support, hard prompt ceiling UNKNOWN until verified; Wan
baseline up to 20,000 prompt chars, 10 reference images, 5 reference
videos, 5 reference audio, 30s output, first/last-frame modes incompatible
with multimodal reference modes. Flash is valid FINAL footage when it passes
QC — never auto-discarded as preview-only.

Default routing policy (configurable, not rigid):

```
Agnes Flash (when suitable) → automated QC → PASS: keep
  → likely prompt/seed failure: retry Flash once
  → still FAIL: Agnes regular
  → reference/identity problem remains: Seedance 2.0 Mini
  → especially complex/long/hero/action shot: Wan 3.0
```

Routing also considers shot type, reference needs, character consistency,
quality history, cost, remaining quota, and the user-approved spend ceiling.

Reasoning/vision LLMs (director, writer, script critic, image/video/
continuity/final QC) route via OpenRouter-compatible config; `MAX_REASONING`
is a logical level mapped per-adapter to the highest reasoning effort the
active endpoint supports — never assume every API accepts a literal "max".
Any compatible model ID is allowed; never closed to a fixed set. If a
selected model cannot ingest video directly, FFmpeg extracts representative
frames for image-vision QC.

Image providers (character creation, scene masters, storyboards) carry the
same rigor: prompt char limit, reference count, image-to-image, compositing,
masks, aspect ratios, seed support, cost. Voice: Fish Audio profiles
(model, pace, emotion/style, pronunciation dictionary, proper nouns) —
recurring characters never randomly change voices across episodes.

## Secrets handling

- Provider keys come from the operator's `.env`. Env variable NAMES are
  discoverable (`printenv | cut -d= -f1` filtered to known prefixes, or
  `mmcs doctor`); **values are never printed, logged, or echoed**.
- Never embed user credentials in the product; never use operator
  credentials as a product default. Each end user/client supplies their own.
- `.env.example` contains names + descriptions only
  (`AGNES_API_KEY=`, `KIE_API_KEY=`, `FISH_API_KEY=`, `GHL_ACCESS_TOKEN=`,
  `GHL_LOCATION_ID=`, `OPENROUTER_API_KEY=`, `NINEROUTER_URL=`,
  `NINEROUTER_KEY=`).
- GHL auth uses `Authorization: Bearer <token>` with `Version: v3` — the
  token is never logged. Story/script text is untrusted data and never
  executed.

## Skill packaging & install targets

All three hosts call the same engine and the same persistent project state —
no copied business logic. Canonical source: `skills/mini-movie-creator/`
(this directory). Install wrappers live in `integrations/claude/` and
`integrations/openclaw/`.

1. **Claude Code / claude-nine (project scope):**
   `.claude/skills/mini-movie-creator` → symlink to
   `../../skills/mini-movie-creator`. Verify in a fresh `claude` session:
   invoke `/mini-movie-creator status` and a non-destructive dry run.
2. **Personal scope (after project tests pass):**
   `~/.claude/skills/mini-movie-creator` → symlink to the canonical source;
   verify in a NEW session outside the repo. claude-nine uses
   `~/.claude-nine/skills/` as its primary discovery root with sync from
   `~/.claude/skills/` — nine's tuned real directories win over symlinks.
   **Never overwrite an existing personal skill without backup and explicit
   confirmation.**
3. **OpenClaw:** packaged at `integrations/openclaw/mini-movie-creator/`
   (SKILL.md + references/scripts). Install via
   `openclaw skills install ./skills/mini-movie-creator --as mini-movie-creator --force`
   or workspace placement (`<workspace>/skills` — high precedence). Resolve
   the active workspace from OpenClaw config; **never guess a workspace
   path**. Verify via `openclaw skills list/info/check`; test explicit
   invocation from an OpenClaw agent; verify the skill watcher picks it up
   rather than assuming. OpenClaw persistence (schedules/session state in
   its own SQLite) is secondary resilience — MMCS's own checkpoint state
   (SQLite + `state/checkpoint.json`) is always the source of truth. Re-read
   current OpenClaw docs (skills, creating-skills, cli/skills,
   skills-config, agent-workspace, gateway/restart-recovery,
   automation/cron-jobs, cli/cron) before wiring.

## Provider research rule

Provider APIs change rapidly. Before any adapter work: inspect official
current docs; record source URLs, date verified, model IDs, prompt limits,
reference limits, incompatible modes, pricing/quota. One doc per
provider/model family in `docs/provider-capabilities/`. Never treat this
file or spec.md as more authoritative than a newer official API schema —
preserve product intent, update the implementation, log the discrepancy in
`decisions.md`.