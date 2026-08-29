# Providers reference — capabilities, limits, keys, archival

The engine owns provider truth (capability registry, spec §5; provider
packages Agnes/Kie/Fish). This reference tells the agent how to behave; it
never encodes provider limits itself.

## Rule: capability-first

- Before any generation, trust the engine's capability registry — documented
  limits, per-model reference-image counts, prompt character caps, mode
  exclusivity. Never estimate or hard-code limits in conversation.
- If model-specific limits change (e.g. a capability profile update), the
  routing/validator behavior changes automatically. Do not cache stale limits
  across a project.
- **UNKNOWN is preserved for undocumented Agnes hard prompt maximums.** When
  the engine reports UNKNOWN, say UNKNOWN — do not guess a number.

## Verification

`mmcs providers verify` reports, per provider/model:
- configured capability,
- documented capability,
- runtime-observed capability where safely testable,
- last verified date,
- discrepancy warning.

Use it when generation behaves unexpectedly. A single transient failure never
silently rewrites a VERIFIED capability — report discrepancies to the user.

`mmcs models` lists registered models; `mmcs doctor` checks overall health.

## Fallback routing (engine-decided)

QC results route fallbacks: direct acceptance (Agnes Flash), regular-Agnes
re-generation, Seedance fallback, Wan hero/complex fallback (spec §20). The
engine picks; the agent surfaces the route and the reason. Never force a
fallback the engine did not choose, and never re-roll a shot to dodge QC.

## Provider identities — KIE, never fal.ai

- **Generative video/images in MMCS = `KIE_API_KEY`** (Kie.ai; engine
  capability registry, packages/providers). The engine's single source of
  truth for every recognized key is `packages/core/src/config/schema.ts`
  (`MMCS_ENV_KEYS`: `AGNES_API_KEY`, `KIE_API_KEY`, `FISH_API_KEY`,
  `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `OPENROUTER_API_KEY`,
  `NINEROUTER_URL`, `NINEROUTER_KEY`, `AUTO_SPEND_LIMIT_USD`).
- **`FAL_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY` are NOT engine
  credentials.** They belong to the abandoned upstream Python `tools/` track
  (fork preservation — `docs/upstream-audit/preservation-map.md`). They never
  credential an MMCS provider (enforced by
  `scripts/release/provider-smoke.test.ts`: `FAL_KEY` alone always stays
  MOCKED/BLOCKED). If the agent encounters a fal/fal.ai/FAL_KEY instruction in
  old `.claude/skills/*` (make-ai-short, make-vox — upstream tracks), it does
  NOT apply to MMCS engine work. **Do not use fal.ai for MMCS generation.**

## Keys and secrets

- Provider API keys come from the environment (repo `.env` / `.env.example`
  names: `AGNES_API_KEY`, `KIE_API_KEY`, `FISH_API_KEY`, `GHL_ACCESS_TOKEN`,
  `GHL_LOCATION_ID`, …). The engine reads them; the skill never sees them.
- Never place a key in a command line, in this skill, in a message, or in a
  log. If a command errors on missing credentials, tell the user which
  VARIABLE NAME is missing — never ask them to paste the value into chat.

## Archival — mandatory, immediate

- Provider results arrive on **temporary URLs that expire**. Immediately after
  generation the engine archives assets into GHL Media Storage and persists
  file ID + canonical URL + checksum. Do not schedule archival "later"; do
  not build steps that read from the temp URL after the generation step.
- `mmcs storage status` shows storage health; `mmcs character show <id>` and
  `mmcs character list` resolve canonical character assets from the DB, never
  from a remembered URL.