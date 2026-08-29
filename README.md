# mini-movie-creator-system (MMCS)

A persistent, resumable AI **mini-movie / serialized-TV production engine** —
a recurring locked character developed across episodes and rendered as a
vertical short. Engine-first: all production state lives in durable storage
(SQLite + `state/`), all business logic lives in packages, and the Claude
Code skill is a **thin control interface** — never the brain.

This repo began as a fork of
[hassancs91/claude-faceless-shorts-creator](https://github.com/hassancs91/claude-faceless-shorts-creator)
(MIT; upstream Remotion baseline and the legacy `/make-short`, `/make-ai-short`,
`/make-vox` tracks are preserved and attributed forever — see
`docs/upstream-audit/preservation-map.md`). MMCS adds the production engine on
top; the upstream tracks still work.

## Quickstart

```bash
bash scripts/release/clean-install.sh
```

One command: verifies prerequisites (Node 20+/git/ffmpeg+ffprobe, pnpm
auto-provisioned via corepack), installs the pnpm workspace, builds the `mmcs`
CLI, and runs `mmcs doctor`. Exits 0 on a verified install — **no provider
keys needed first**; `mmcs doctor` requires no secrets. Full steps, `.env`
tables, and install troubleshooting: `docs/installation.md`.

```bash
cp .env.example .env    # add provider keys when you are ready to generate
mmcs doctor             # names only — shows which providers are wired
```

## Drive it

Open the repo in Claude Code / claude-nine — `/mini-movie-creator` loads the
operator skill (`skills/mini-movie-creator/`), a thin control interface that
drives the same `mmcs` CLI the engine ships. Or drive the CLI directly
(`node apps/cli/dist/index.js` if not on PATH):

```bash
create-series → create-episode
  → develop-concept      [GATE 1 concept]
  → write-script         [GATE 2 script]
  → cast → choose-character 1|2|3 → approve-character   [GATE 3 character lock]
  → storyboard           [GATE 4 storyboard]
  → estimate → generate  [auto below $25/episode; STOP at the ceiling]
  → qc → rough-cut       [GATE 5 rough cut]
  → final → canon review/approve   [GATE 6 canon]
```

Full walkthrough (free, zero provider calls): `docs/first-series.md` — the
demo series "Mona & the Brass Key", executable as
`npx vitest run examples/demo-series --config examples/vitest.examples.config.ts`.

Six persisted approval gates + one automatic $25/episode spend gate
(`docs/approvals.md`, `docs/cost-controls.md`). Every generated asset
archives immediately to durable GoHighLevel Media Storage (`docs/ghl-setup.md`).

## Verify without spending anything

| Command | What it proves |
|---|---|
| `bash scripts/release/clean-install.sh` | pristine install: prereqs, workspace, CLI build, doctor (REL-001) |
| `bash scripts/release/e2e-dry-run.sh` | full pipeline S0–S23 with mocked paid steps and a **real ffmpeg render** — zero credentials, zero spend (REL-004) |
| `bash scripts/release/provider-smoke.sh` | credential gating per provider, $0 projection inside the $25 gate (REL-005) |
| `bash scripts/release/regression.sh` | six-area release sweep: tools / vitest / gen / typecheck / lint / render-smoke (REL-002) |

Committed evidence reports (script-generated, never hand-edited):
`docs/e2e-dry-run-report.md`, `docs/provider-smoke-report.md`.

## Engine layout (summary)

```
packages/                the engine (13 subsystem packages)
  core                   approvals + gates, config, recovery/checkpoint, state machine
  scene-intelligence     intake → concept → screenplay → shots → keyframes → storyboards
  character-library      candidates, cast, locking, identity assets, series bible
  capability-registry    per-model limits/pricing data + validators (`mmcs models`)
  providers/             agnes, kie (seedance/wan), fish-audio adapters
  media-storage          MediaStore + GoHighLevelMediaStore (durable archive)
  cost-engine            atomic shared reservation ledger ($25 gate)
  qc/                    QC evaluators + repair routing
  remotion-runtime       composition/render bridge (rough cut, final render, ffprobe)
  database  domain  prompt-compilers
apps/
  cli/                   the `mmcs` CLI (spec §24 verb surface)
  api/                   thin HTTP service boundary (standalone readiness)
  web/                   reserved — no V1 dashboard
integrations/
  claude/                Claude Code / claude-nine skill install wrappers
  openclaw/              OpenClaw skill packaging + workspace install
skills/mini-movie-creator/   canonical skill (one skill, three install targets)
remotion/                upstream Remotion project, evolved
examples/demo-series/    the free end-to-end walkthrough as tests
scripts/release/         release gates (clean-install, e2e-dry-run, provider-smoke, regression)
state/                   orchestration state (checkpoint.json, schema, README)
```

Package map and the binding dependency direction:
`docs/ARCHITECTURE.md`.

## Where the docs live

| Start here | For |
|---|---|
| `docs/installation.md` | install, prerequisites, `.env` reference, skill hosts |
| `docs/first-series.md` | your first series, end to end (free) |
| `docs/approvals.md` · `docs/cost-controls.md` | the six gates + the $25 gate |
| `docs/character-library.md` | recurring characters, candidates, locking |
| `docs/provider-setup.md` · `docs/ghl-setup.md` | provider keys, GHL archive |
| `docs/capability-registry.md` · `docs/adding-a-provider.md` · `docs/provider-capabilities/` | model limits/pricing, new providers |
| `docs/skill-installs.md` | Claude Code / claude-nine / OpenClaw installs |
| `docs/troubleshooting.md` · `docs/recovery.md` | symptoms, resume, drills |
| `docs/standalone-path.md` | building an app on the engine |

## Branch model

`main` (integration-tested, usable) · `integration` (10-minute QC-approved
batch merges) · task branches/worktrees. No direct-to-main agent commits
(spec §2). Release gates run from `scripts/release/`; the merge/promotion
flow is documented in `scripts/orchestration/` (batch merge, watchdog,
checkpoint).

## License

MIT — see [LICENSE](LICENSE). Fork attribution to the upstream
faceless-shorts-creator project is preserved permanently
(`docs/upstream-audit/preservation-map.md`).