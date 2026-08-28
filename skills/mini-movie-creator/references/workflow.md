# MMCS Workflow Reference — stage-by-stage operating procedure

Exact CLI verbs for the calling agent. Verb names match spec §24 and the
`mmcs` dispatcher registry (`apps/cli/src/dispatch/registry.ts`). Multi-word
verbs are real nested subcommands (`mmcs approve concept`, not
`mmcs approve concept`).

Before EVERY stage transition: `mmcs status`. It shows episode state, the
active approval gate, and cumulative spend. If `status` reports a gate that
is not yet approved, the only legal verbs are the gate verbs and read-only
verbs.

## Stage 0 — Locate & health-check

```bash
mmcs doctor      # environment, provider config, DB health; safe to run anywhere
mmcs status      # current project state
```

If `doctor` reports missing provider keys, report which env VARIABLE NAMES
are unset. Never ask the user to paste a secret into chat; direct them to
their `.env`.

## Stage 0b — Create/open series or standalone

```bash
mmcs create-series
mmcs create-episode
```

Collect persistent defaults **once** at series creation: series title; output
format (default **16:9 landscape**; 9:16 vertical; supported custom aspect);
target runtime range; visual style; default director/writer/QC models;
preferred video routing policy; GHL storage location/root; default spend
threshold. Reasonable defaults, editable later — never a 50-question setup.
The master format is never re-asked every episode unless the user wants a
change. Standalone movies use the same engine without series scaffolding
(stored under `Standalone Movies/<Project Name>/` in GHL).

## Stage 1 — Concept [GATE 1]

```bash
mmcs develop-concept
```

Present the developed concept. **STOP.** No screenplay work before explicit
approval. On approval:

```bash
mmcs approve concept
```

## Stage 2 — Script [GATE 2]

```bash
mmcs write-script
```

Present the screenplay. **STOP.** No cast/candidate work before approval:

```bash
mmcs approve script
```

## Stage 3 — Cast & characters [GATE 3]

```bash
mmcs cast                          # resolve recurring cast from Character Library; propose new-character candidates
mmcs choose-character <candidate>  # "1" | "2" | "3" | "try-again"
mmcs approve-character <id>        # LOCK — only then CANONICAL
mmcs character list
mmcs character show <id>
```

Rules:

- Recurring characters resolve to permanent library IDs
  (`CHAR_MONICA_BENNETT_001` style). Never display-name-keyed.
- **Exactly 3 candidates** for a genuinely new character, shown as
  Character 1 / 2 / 3. The user picks `1 / 2 / 3 / 4-Try Again`. Try Again
  creates three NEW candidates; previous rejected candidates stay
  draft/rejected forever and are never reused.
- Lock only after explicit approval. Every approved reference is archived to
  GHL immediately; persist **GHL file ID + canonical URL + folder ID +
  SHA-256 + generation metadata** and use those IDs verbatim downstream.
- Identity/wardrobe/hair changes create NEW versions with an effective
  episode; they never overwrite the base identity master. Historical
  episodes keep referencing the canon-at-the-time version.

## Stage 4 — Storyboard [GATE 4]

```bash
mmcs storyboard
mmcs approve-storyboard
```

The planner breaks approved scenes into camera shots (a 45-second scene is
typically 5–8 shots), keeps every shot inside the selected model's duration
limit, and classifies each shot's keyframe strategy — mutually exclusive:
zero keyframes / one starting keyframe / start+end keyframes / scene master +
references / multimodal reference package. Reference budget is **minimum
sufficient** — never fill a model's maximum because it exists. Validate
prompt-character and reference counts against the capability registry
BEFORE any provider call; UNKNOWN limits stay UNKNOWN.

**STOP for storyboard approval. No paid generation before Gate 4.**

## Stage 5 — Estimate & generate [$25 spend gate]

```bash
mmcs estimate      # provider usage/cost before production generation
mmcs generate      # all shots; or:
mmcs generate-shot <id>
```

Cost rules (engine-enforced, you never override):

- Cumulative projected paid spend **< $25.00** per episode → proceeds
  automatically.
- A request that would reach **$25.00 or above** → engine stops for explicit
  user approval before crossing.
- Budget reservation is atomic against one shared ledger before submission
  (job state BUDGET_RESERVED). Parallel workers cannot collectively exceed
  the limit. Release on failure/rejection.
- Included subscription quota / free allowance is tracked separately and
  never counted as paid spend.

Dialogue/voices are generated as separate durable assets (Fish Audio voice
profiles; pronunciation dictionary; recurring characters never randomly
change voices across episodes).

**Immediate archival:** the engine archives every provider output into GHL
Media Storage on completion — temporary provider URLs are never canonical
storage. Never regenerate expensive media merely because archival failed;
the original provider task/job ID is always persisted.

## Stage 6 — QC

```bash
mmcs qc
```

Every generated shot is QC'd (identity, face/skin/hair/wardrobe, anatomy,
props, location, lighting, camera/action requirement, artifacts, lip/face,
start/end state, neighboring-shot continuity, dialogue suitability) before
final use. Failure → **targeted repair of the affected shot only**:

```bash
mmcs retry-shot <id>
```

Routing on retry per shot class: Agnes Flash → Agnes regular → Seedance →
Wan (hero/complex) → human REVIEW when automated routes exhaust. Never blind
whole-episode regeneration.

## Stage 7 — Rough cut [GATE 5]

```bash
mmcs rough-cut
mmcs approve rough-cut
```

**STOP.** Present the assembled rough cut. Only affected assets regenerate
on revision (individual shot replacement/trim, voice/music/caption
correction). No final render before approval.

## Stage 8 — Final

```bash
mmcs final
```

Final render → ffprobe validation → final QC → archive into `08 Final/` →
production report (runtime; aspect ratio/resolution; providers/models used;
generated/accepted/rejected seconds; retries; cost; quota usage; characters;
canon changes; durable final URL; QC status). A 720p generated source
upscaled to 1080p is reported as upscaled, never as native 1080p.

## Stage 9 — Canon [GATE 6]

```bash
mmcs canon review    # propose continuity changes (e.g. "Marcus broke his arm")
mmcs canon approve   # apply — only after explicit user approval
```

No permanent Series Bible update without approval. Historical episodes
reference the canon state at their time.

## Storage & assets

```bash
mmcs storage status
```

GHL folder tree (idempotent — search before create, never duplicate roots):

```text
Convert and Flow/
  Character Library/<Character Name>/
    Identity Masters/ Expressions/ Wardrobe/ Voice References/ Approved Scene References/
  Series/<Series Name>/
    Series Bible/ (Characters/ Locations/ Wardrobe/ Props/)
    Season 01/S01EXX - <Episode Title>/
      01 Script/ 02 Characters/ 03 Scene Masters/ 04 Storyboards/ 05 Audio/
      06 Video Clips/ 07 Rough Cut/ 08 Final/ 09 QC Metadata/
  Standalone Movies/<Project Name>/ (same 01–09 subfolders)
```

Every media asset has a durable DB record (never filenames alone):
`asset_id, series_id, episode_id, scene_id, shot_id, character_id,
character_version, asset_type, asset_state, provider, provider_model,
provider_task_id, original_provider_url, provider_url_expiration, ghl_file_id,
ghl_folder_id, ghl_url, checksum, local_path, prompt, prompt_character_count,
references_used, generation_settings, cost, generation_seconds, created_at,
archived_at, approval_state, qc_state`. Deterministic filenames, provenance
in the DB: `S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4`,
`character_monica_face_3q_master_v02.png`.

## Output formats

16:9 and 9:16 rough cuts must both render. Format is stored at series level
with per-episode override.