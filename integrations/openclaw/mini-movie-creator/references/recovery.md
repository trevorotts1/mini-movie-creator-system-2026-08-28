# Recovery reference — resume after restart, crash, or interruption

MMCS keeps its own checkpoint state in the repo's `state/` (checkpoint.json +
schema). The engine's recovery commands rebuild in-flight work from that
state. OpenClaw's own persistence (sessions, schedules) is secondary
resilience only — **never the source of truth**.

## Recovery procedure (in order)

1. **Re-read, never recall.** Run `mmcs status` (or `scripts/mmcs-status.sh`).
   Everything you "know" about the project before the interruption is
   provisional until status confirms it.
2. **Rehydrate.** Run `mmcs recover`. It restores the active task map and
   provider polling from the checkpoint. Verify the reported active project /
   episode / stage matches `mmcs status`.
3. **Resume polling, never resubmit.** If a provider job was submitted before
   the interruption, `mmcs recover` resumes polling that exact job ID. Never
   call a submit verb for a job that may already exist — duplicate paid jobs
   are the one unrecoverable mistake. When unsure whether a job was
   submitted, check `mmcs status` / job state through the CLI, and if it is
   genuinely ambiguous, ask the user before submitting anything paid.
4. **Gates are durable.** Any approval gate that was open stays open. Re-present
   the artifact; never auto-approve after recovery.
5. **Idempotent re-entry.** Re-running `mmcs recover` after a successful
   recovery is safe; state updates are idempotent (spec §13 primitives).

## What survives where

| State | Lives | Survives restart |
| --- | --- | --- |
| Projects, episodes, characters, shots, jobs, assets, approvals, QC, costs | engine SQLite DB | yes |
| Orchestration checkpoint (active task map, in-flight jobs) | repo `state/checkpoint.json` | yes |
| Approval gate decisions | engine DB + state machine | yes |
| OpenClaw sessions/schedules | OpenClaw's own SQLite | yes, but secondary |
| Provider temporary URLs | provider-side | **no — expired; assets were archived to GHL** |

## Failure shapes

- **Gateway/tool restart mid-poll:** recover (step 2); polling continues on
  the stored job ID.
- **Partial episode (some shots generated):** `mmcs status` shows per-shot
  state; continue only at the failed/affected shots via
  `mmcs retry-shot <id>`.
- **Lost conversation context:** the DB + checkpoint are the truth; rebuild
  your summary from `mmcs status` output, never from memory.

## What NOT to do

- Do not edit `state/` files by hand.
- Do not open the SQLite DB directly.
- Do not resubmit jobs "to be safe".
- Do not treat OpenClaw's session memory as project state.