---
name: mini-movie-creator
description: MMCS (mini movie creator system) — drive the local `mmcs` engine CLI to take one idea from intake to a finished, QC'd video episode: concept → script → cast from the Character Library → shots/storyboard → provider generation (Agnes/Kie/Fish) → GHL Media Storage archival → rough cut → final render, with hard STOP approval gates (concept, script, character lock, storyboard, rough cut) and a $25.00 cumulative paid-spend authorization wall. Use when the user wants to create a video series or standalone episode, make an AI mini-movie, check MMCS project status, or resume an in-flight MMCS project. Never bypass approvals or cost controls; never edit media directly when a `mmcs` command exists.
---

# mini-movie-creator — OpenClaw skill packaging (thin control interface)

This skill is a **control interface over the `mmcs` engine**, not a fork of it.
All business logic, state, and persistence live in the engine and its SQLite DB.
This skill teaches the calling OpenClaw agent how to drive that engine safely.
It never copies business logic, never touches the database directly, and never
edits media files when a `mmcs` command exists.

## 0. Locate the engine first

The engine is the `mmcs` CLI inside the MMCS monorepo checkout. Resolve it in
this order — **never guess a path**:

1. `MMCS_ROOT` environment variable, if set. The engine lives at
   `$MMCS_ROOT/apps/cli` (built CLI: `$MMCS_ROOT/apps/cli/dist/index.js`).
2. Walk upward from the current working directory looking for a checkout whose
   root `package.json` has `"name": "mmcs-monorepo"`.
3. If neither resolves, ask the user for the checkout path. Do not invent one.

Once located, prefer, in order:

```bash
mmcs <verb…>                                  # if `mmcs` is on PATH
node "$MMCS_ROOT/apps/cli/dist/index.js" <verb…>   # built CLI
```

If the CLI is not built, run `npm run build` in `apps/cli` once (see the repo
README) — do not reimplement verbs inside this skill.

Every command below is shown as `mmcs <verb>`; substitute the `node …` form
when `mmcs` is not on PATH. Engine failure output (`[mmcs] …` on stderr) is
diagnostic truth — surface it, do not retry blindly around it.

## 1. Read state before mutating anything

**Always run `mmcs status` first.** It shows the active project/series/episode,
current pipeline stage, and which approval gates are open. The convenience
wrapper `scripts/mmcs-status.sh` (next to this SKILL.md) resolves the engine
root and prints the same status. OpenClaw resolves relative paths inside a
skill against the skill directory (parent of SKILL.md) — run it as:

```bash
{baseDir}/scripts/mmcs-status.sh
```

State rules the agent must respect:

- **All durable application state is the engine's SQLite DB** (projects,
  series, episodes, characters, shots, jobs, assets, approvals, QC, costs).
  Read it through `mmcs` verbs only. Never open or write the DB file directly.
- Orchestration checkpoints live in the repo's `state/` (checkpoint.json) and
  are managed by the engine's recovery commands — not by this skill.
- OpenClaw's own persistence (sessions, schedules) is secondary resilience
  only. MMCS checkpoint state, not OpenClaw state, is the source of truth.

## 2. The pipeline and its hard gates

Full detail: read `references/workflow.md` before driving a project.

```
intake → concept ── STOP: approve concept
       → script ── STOP: approve script
       → cast (Character Library) → character candidates
              → STOP: choose Character 1 / 2 / 3 / Try Again → lock
       → scene/shot plan → keyframe vs multimodal-reference decision per shot
       → storyboard ── STOP: approve storyboard
       → estimate → generate (voices, images, video) → archive to GHL
       → QC/continuity → rough cut ── STOP: approve rough cut
       → revise affected shots only → final render
       → canon proposals ── STOP: approval before Series Bible update
```

Gate verbs (examples): `mmcs approve concept`, `mmcs approve script`,
`mmcs approve rough-cut`,
`mmcs choose-character <candidate>`, `mmcs approve-character <id>`,
`mmcs approve-storyboard`, `mmcs canon approve`. If a gate is unmet, the CLI
refuses the next step — that refusal is the product working. Never bypass a
gate by editing state files or the DB.

## 3. Cost wall — never cross it

- The engine auto-authorizes cumulative episode **paid spend strictly below
  $25.00**. At **$25.00 or above it stops and requires explicit approval**.
- Never split, shard, or parallelize requests to stay under the wall.
- Two concurrent reservations must never be used to defeat the limit; the
  engine enforces this — do not engineer around it.
- Before any generation, `mmcs estimate` and report the projected spend.

## 4. Characters and canon

Full detail: `references/workflow.md` (cast flow) — the non-negotiables:

- Resolve cast from the global Character Library before creating anyone new.
- Genuinely new characters get exactly 3 generated candidates; offer the user
  `Character 1 / 2 / 3 / Try Again`; lock only after explicit choice.
- Persist the exact GHL file ID, canonical GHL URL, checksum, and character ID
  the engine returns — never a re-derived or "cleaner" variant.
- Series Bible changes are proposals only until approved (`mmcs canon approve`).

## 5. Providers — capability-first, never assume

Full detail: `references/providers.md`. Before calling a provider verb:

- Trust the engine's capability registry (documented limits, per-model
  reference-image counts, prompt caps). Do not estimate limits yourself.
- `mmcs providers verify` reports configured vs documented vs runtime-observed
  capability and last-verified date; use it when behavior looks wrong.
- Provider temporary URLs expire — engine archival into GHL Media Storage is
  mandatory immediately after generation; never rely on the temp URL later.
- Required API keys are supplied via the environment (`.env`), never embedded
  in this skill or in messages.

## 6. Recovery — resume, do not resubmit

Full detail: `references/recovery.md`. After a restart or interruption:

1. `mmcs status` (or the `mmcs-status.sh` wrapper) — rebuild the picture.
2. `mmcs recover` — rehydrate the active task map; polling resumes the
   existing provider job IDs; **never resubmit** a job that may already exist
   (idempotency is the engine's job, duplication is yours to avoid).
3. Approval gates survive restarts: a gate that was pending stays pending.

## 7. What this skill must NOT do

- No engine forking: no business logic, no SQL, no media manipulation here.
- No secrets: no API keys in this skill, in commands, or in message text.
- No client messaging: this skill drives the local engine only.
- No direct writes to `state/` control files or the SQLite DB.
- No paid generation without the estimate + gate discipline in §3.

## 8. Quick reference

| Need | Command |
| --- | --- |
| Health + state | `mmcs status` / `mmcs doctor` |
| New series / episode | `mmcs create-series`, `mmcs create-episode` |
| Writing stages | `mmcs develop-concept`, `mmcs write-script` |
| Approvals | `mmcs approve concept\|script\|storyboard\|rough-cut` |
| Cast | `mmcs cast`, `mmcs choose-character <candidate>`, `mmcs approve-character <id>` |
| Planning | `mmcs storyboard`, `mmcs estimate` |
| Generation | `mmcs generate`, `mmcs generate-shot <id>`, `mmcs retry-shot <id>` |
| QC + cuts | `mmcs qc`, `mmcs rough-cut`, `mmcs final` |
| Canon | `mmcs canon review`, `mmcs canon approve` |
| Providers + storage | `mmcs providers verify`, `mmcs models`, `mmcs character list`, `mmcs character show <id>`, `mmcs storage status` |
| Recovery | `mmcs recover` |

Unknown state → run `mmcs status` and answer from its output, never from
memory or invention.