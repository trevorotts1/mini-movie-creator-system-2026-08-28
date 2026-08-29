# mini-movie-creator (skill 75) — OpenClaw integration

Thin control interface over the MMCS engine CLI. The skill instructs; the
engine (`apps/cli`, `packages/*`) executes. Read `SKILL.md` for the runbook;
read `references/` for workflow/provider/recovery detail.

## Client install (Gaps A/B)

`install-client.sh` performs a three-step, idempotent, fleet-safe install on a
client OpenClaw box, in one pass:

1. **Copy the skill** into the client's skills dir as `75-mini-movie-creator`
   (slot 75, slug `mini-movie-creator`). Skip if already present.
2. **Gap A — routing-map registration:** insert a slug-checked entry into the
   client's `skill-department-map.json` (dept `video`, role
   `automated-video-production-specialist-openmontage`, `primary: false`) so
   requests route to this skill. No duplicate rows, ever.
3. **Gap B — AGENTS.md when/how block:** append the
   `## MMCS mini-movie engine (skill 75)` block, marker-checked so it is
   appended once and only once.

Backups (`*.bak-mmcs75`) are written next to each mutated file before change.
After install it runs `env-preflight.sh` to prove READY.

Installers never touch credentials, models, or client sovereignty.

```bash
bash install-client.sh                        # full install
bash install-client.sh --dry-run              # print plan, write nothing
bash install-client.sh --fix                  # install + attempt dependency repair
```

| Flag | Default | Meaning |
|---|---|---|
| `--skills-dir DIR` | `/home/node/.openclaw/skills` | client skills dir |
| `--skill-slot NN` | `75` | skill slot number |
| `--map PATH` | `…/23-ai-workforce-blueprint/skill-department-map.json` | routing map |
| `--agents PATH` | `/home/node/.openclaw/workspace/AGENTS.md` | client AGENTS.md |
| `--dry-run` | off | plan only, write nothing |
| `--fix` | off | also run `env-preflight.sh --fix` |

`MMCS_*` env vars override the same defaults (`MMCS_SKILLS_DIR`,
`MMCS_SKILL_SLOT`, `MMCS_MAP`, `MMCS_AGENTS`, `MMCS_REPO_SRC`). Source skill
is located automatically: `$MMCS_ROOT`, `/home/node/mmcs`, or the checkout
containing this file.

## Env preflight

The engine's runtime gate — run before any media work and after a
machine/container change:

```bash
bash scripts/env-preflight.sh          # check-only
bash scripts/env-preflight.sh --fix    # auto-install missing deps, then re-verify
bash scripts/env-preflight.sh --json   # {"ready":true|false,"pass":N,"fail":N}
```

Checks: node >= 20, git, ffmpeg + ffprobe, remotion deps (incl. TypeScript 5.x —
installed with `npm ci --include=dev`; a bare `npm ci` skips devDeps and the
render pipeline crashes with `typescript.sys` undefined), built mmcs CLI.
Exit 0 = READY, exit 2 = BLOCKED with named remedies. Never reads secret
values.

## Providers — KIE, never fal.ai

Generative video/images in MMCS use `KIE_API_KEY` (Kie.ai). `FAL_KEY`,
`ELEVENLABS_API_KEY`, `GEMINI_API_KEY` belong to the abandoned upstream Python
`tools/` track and never credential an MMCS provider (enforced by
`provider-smoke.test.ts`). See `references/providers.md`.
