# MMCS Installation

From a fresh clone to a verified install in one command:

```bash
bash scripts/release/clean-install.sh
```

The script verifies prerequisites, installs the pnpm workspace, builds the
`mmcs` CLI, and runs `mmcs doctor`. It exits 0 when the install is verified.
`mmcs doctor` requires **no secrets** — a pristine clone passes with an empty
`.env`; provider keys only unlock generation features (spec §32 step 2).

## Prerequisites

| Requirement | Minimum | Why | Check |
|---|---|---|---|
| git | any recent | clone + repo integrity | `git --version` |
| Node.js | **20+** (`engines` floor in root `package.json`) | engine + CLI runtime; the SQLite driver is Node's built-in `node:sqlite` | `node --version` |
| pnpm | pinned by `packageManager` in root `package.json` (corepack auto-provisions when missing) | workspace install | `pnpm --version` |
| ffmpeg + ffprobe | 6.x+ | media probing/transcoding/normalization (spec §21) | `ffmpeg -version` |

macOS (arm64): `brew install node ffmpeg pnpm`. Linux: your package manager or
[nvm](https://github.com/nvm-sh/nvm) + `corepack enable pnpm`.

Not required for install/doctor: provider API keys, Python, Remotion deps
(`remotion/` installs separately with npm per its own lockfile — see
[Rendering](#rendering-remotion)).

## Clean install (step by step)

```bash
git clone https://github.com/trevorotts1/mini-movie-creator-system-2026-08-28.git
cd mini-movie-creator-system-2026-08-28
bash scripts/release/clean-install.sh
```

What the script does:

1. **Prerequisites** — hard-checks node >= 20, git, ffmpeg/ffprobe. A missing
   hard prerequisite aborts before anything is mutated.
2. **Repo layout** — verifies you are in the MMCS monorepo (`apps/cli`,
   `packages/core`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.env.example`).
3. **Workspace install** — `pnpm install --frozen-lockfile` (reproducible; the
   lockfile is the source of truth). If you intentionally changed a
   `package.json`, opt out once with
   `MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE=1 bash scripts/release/clean-install.sh`.
   When `pnpm` is missing, the script provisions the pinned version via
   `corepack` (no global config changes).
4. **CLI build** — `pnpm --filter @mmcs/cli build` → `apps/cli/dist/index.js`
   (the `mmcs` bin).
5. **Doctor** — runs `node apps/cli/dist/index.js doctor` and reports its exit
   code. Doctor reads provider config leniently (CORE-010 `tryLoadConfig`):
   missing keys are *findings*, not failures, so a clean clone passes.
6. **Env scaffold** — copies `.env.example` → `.env` **only when `.env` does
   not exist**. Names only; you fill in values. An existing `.env` is never
   touched. Skip with `--no-env-copy`.

Useful flags: `--skip-doctor` (structure + build only), `--no-env-copy`,
`--json` (one JSON summary line for scripting), `--help`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | install verified (`mmcs doctor` passed) |
| 1 | any check failed — fix the `FAIL:` lines and rerun (safe to rerun; the script is idempotent) |
| 2 | usage error (unknown option; see `--help`) |

## `.env` configuration

`.env` lives at the repo root and is **gitignored — never commit it**.
`.env.example` (tracked) lists every variable NAME with no values. Copy and
fill in what you use; MMCS reads it via the CORE-010 config loader (real
environment variables win over file values). Blank/unknown entries are simply
"not configured" — `mmcs doctor` tells you which ones are missing, and never
prints values.

### MMCS engine variables

| Variable | Required for | Purpose |
|---|---|---|
| `AGNES_API_KEY` | text/character/story generation | Agnes AI — default director/writer/QC model routing (spec §14) |
| `KIE_API_KEY` | video/keyframe generation | Kie.ai — Seedance/Wan video jobs, keyframes (spec §15) |
| `FISH_API_KEY` | dialogue/TTS | Fish Audio voice lines (spec §16) |
| `GHL_ACCESS_TOKEN` + `GHL_LOCATION_ID` | media storage | GoHighLevel durable asset archival (spec §17) — always your own subaccount credentials |
| `OPENROUTER_API_KEY` | optional fallback | OpenRouter multi-provider model fallback |
| `NINEROUTER_URL` + `NINEROUTER_KEY` | optional local routing | 9Router local model router (engine-side model calls) |
| `AUTO_SPEND_LIMIT_USD` | optional | cumulative paid-spend auto-authorization ceiling; **defaults to 25** — below it generation auto-proceeds, at/above it requires approval (spec §33) |

### Inherited upstream variables (only for the legacy Python `tools/` track)

| Variable | Used by |
|---|---|
| `ELEVENLABS_API_KEY` | `tools/gen_voice.py`, `tools/gen_sfx.py`, `tools/gen_music.py` |
| `GEMINI_API_KEY` | `tools/gen_image.py` |
| `FAL_KEY` | `tools/gen_clip.py` (optional generative clips) |

### Config loading rules (CORE-010)

- Values come from the process environment first, then repo-root `.env`.
- Empty/whitespace values count as **unset**.
- `mmcs doctor` uses the lenient loader: reports every unset key by name with
  a fix hint, never throws, never echoes values.
- Mutating verbs (generation, storage) use the strict loader: they refuse to
  run until their required credentials are configured.

## Verify the install

```bash
node apps/cli/dist/index.js doctor    # environment, providers, config health
mmcs providers verify                  # configured vs documented capability (never a paid call)
```

If `mmcs` is not on PATH, build it once (`pnpm --filter @mmcs/cli build`) and
invoke `node apps/cli/dist/index.js` — identical verb surface. Full CLI
reference: `skills/mini-movie-creator/references/workflow.md` (spec §24).

## Skill hosts (Claude Code / claude-nine / OpenClaw)

The canonical skill ships in `skills/mini-movie-creator/`; the committed
symlink `.claude/skills/mini-movie-creator` makes a fresh Claude Code or
claude-nine session discover it with no extra step. To (re)install or verify:

```bash
bash integrations/claude/project-install.sh --check   # verify (exit 0 = installed)
bash integrations/claude/project-install.sh           # (re)install
```

OpenClaw: `bash integrations/openclaw/install.sh --check` (installs into the
config-resolved active workspace; never guessed). Details:
`integrations/claude/PROJECT-INSTALL.md`, `integrations/openclaw/`.

## Rendering (Remotion)

`remotion/` is a self-contained npm project with its own lockfile (upstream
baseline, Remotion 4.0.486 — spec §2):

```bash
cd remotion && npm install && npm run gen && cd ..
```

`npm run gen` regenerates the composition registries. Render smoke tests are
part of the regression suite (`scripts/release/regression.sh`, REL-002), not
the clean install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `corepack failed to activate pnpm` | `corepack enable pnpm` once, or `npm i -g pnpm`, then rerun |
| `pnpm install failed` | rerun the raw command `pnpm install --frozen-lockfile` to see the error; delete `node_modules` and retry if the store is corrupted |
| `mmcs doctor exited non-zero` | run `node apps/cli/dist/index.js doctor` directly for the failing check |
| `node:sqlite` unavailable | Node < 22 lacks stable `node:sqlite` — upgrade Node (20/22+ LTS) |
| `ffmpeg/ffprobe missing` | `brew install ffmpeg` (macOS) or your distro's ffmpeg package |
| doctor lists missing keys you thought you set | check `.env` is at the repo root, names match `.env.example` exactly, values are non-blank, and no shell env overrides them |

## Next steps

1. Fill `.env` with your provider keys (see tables above).
2. `mmcs doctor` again — zero missing keys expected.
3. Create a series: `mmcs create-series` (the one-time setup asks only the
   persistent defaults — title, format, runtime range, style, models, routing,
   storage root, spend threshold; spec §24).
4. Full operation manual: `skills/mini-movie-creator/SKILL.md` — or just open
   Claude Code / claude-nine in the repo and invoke `/mini-movie-creator`.
