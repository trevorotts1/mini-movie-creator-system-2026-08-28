# Workflow reference — MMCS pipeline in depth

Read this before driving a multi-stage project. The SKILL.md holds the rules;
this file holds the detail. The `mmcs` CLI (spec §24) is the only interface —
this reference never bypasses it.

## Stage flow and gates

| # | Stage | Verb(s) | Gate before proceeding |
| --- | --- | --- | --- |
| 1 | Environment check | `mmcs doctor` | — |
| 2 | State read | `mmcs status` | always first |
| 3 | Series/standalone setup | `mmcs create-series`, `mmcs create-episode` | collect persistent defaults once |
| 4 | Intake | idea + aspect ratio (default 16:9) + target runtime range | — |
| 5 | Concept | `mmcs develop-concept` | **STOP → `mmcs approve concept`** |
| 6 | Script | `mmcs write-script` | **STOP → `mmcs approve script`** |
| 7 | Cast | `mmcs cast` | resolve from Character Library first |
| 8 | New characters | 3 candidates | **STOP → `mmcs choose-character <candidate>` / Try Again** |
| 9 | Lock | `mmcs approve-character <id>` | only after explicit choice |
| 10 | Plan | scene/shot plan; per shot: 0/1/2 keyframes or multimodal reference package | validate model limits before generating |
| 11 | Storyboard | `mmcs storyboard` | **STOP → `mmcs approve-storyboard`** |
| 12 | Estimate | `mmcs estimate` | report projected spend |
| 13 | Generate | `mmcs generate`, `mmcs generate-shot <id>`, `mmcs retry-shot <id>` | spend wall (below) |
| 14 | Archive | engine writes assets to GHL Media Storage immediately | never rely on provider temp URLs |
| 15 | QC | `mmcs qc` | continuity/identity checks pass or route fallback |
| 16 | Rough cut | `mmcs rough-cut` | **STOP → `mmcs approve rough-cut`** |
| 17 | Revise | `mmcs retry-shot <id>` on affected shots ONLY | never regenerate unaffected shots |
| 18 | Final | `mmcs final` | — |
| 19 | Canon | `mmcs canon review` | **STOP → `mmcs canon approve`** before Bible update |

## Gate behavior

- A gate refusal from the CLI is the approval state machine working (spec §8).
- Gates persist across restarts. After any interruption, re-read state with
  `mmcs status` before continuing; the gate that was pending is still pending.
- Present exactly the choices the CLI/user contract defines (e.g.
  `Character 1 / 2 / 3 / Try Again`). Do not invent extra options.

## Setup defaults (collect once, not 50 questions)

Series title; output format (default 16:9); target runtime range; visual
style; default director/writer/QC models; preferred video routing policy; GHL
storage root; default spend threshold. All editable later via the engine.

## Generation discipline

1. `mmcs estimate` before any paid call; state the projected cumulative spend.
2. Auto-authorization covers cumulative paid spend **strictly below $25.00**
   per episode. At **$25.00 or above the engine stops for approval**. Never
   split work to duck under the wall; never run concurrent reservations to
   defeat it.
3. Generate per shot; archive to GHL immediately (temporary provider URLs
   expire); then QC.
4. Retries target only failed/affected shots (`mmcs retry-shot <id>`).
5. QC routing picks direct-video vs extracted-frame checks automatically; an
   Agnes Flash result may be accepted directly, regular-Agnes and Seedance/Wan
   fallbacks follow the QC route (spec §20). Surface QC rejections; do not
   retry-loop past the engine's policy.

## Character + canon persistence

- On lock, the engine persists: exact GHL file ID, canonical GHL URL,
  checksum, character ID. Echo these exactly; never re-derive.
- Appearance/wardrobe/hair variants do not change the base identity ID.
- Series Bible events accumulate as proposals; `mmcs canon approve` commits.

## Recovery loop

1. `mmcs status` → 2. `mmcs recover` → 3. resume at the first open gate.
- Polling resumes existing provider job IDs; never resubmit a submitted job.
- See `references/recovery.md` for the full procedure.