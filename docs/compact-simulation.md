# Compact Simulation (REC-011)

Acceptance evidence for spec §32 **Recovery**: *manual /compact updates the
checkpoint; a simulated new/resumed session injects/reads state; no data loss
across compaction; the simulation script exits 0.*

Owner: task REC-011 (`scripts/orchestration/compact-sim.*`). Everything below
runs against **real subsystem code** — REC-002's PreCompact flush
(`scripts/hooks/pre-compact.ts`), REC-003's PostCompact hook
(`scripts/hooks/post-compact.ts`), REC-004's SessionStart hook
(`scripts/hooks/session-start.ts`), and CORE-014's `CheckpointService`
(`packages/core/src/recovery/`) — in sandboxed temp directories. No providers
are contacted, nothing paid, nothing in the live repo is mutated.

## Run it

```bash
# The simulation script itself (acceptance: exits 0)
npx tsx scripts/orchestration/compact-sim.ts            # from the repo root
echo $?

# The vitest suite (same scenarios, plus unit-level assertions):
npx vitest run --config scripts/orchestration/vitest.config.mts scripts/orchestration/compact-sim.test.ts
```

Sample output (all steps green → exit code 0):

```
=== MMCS compact simulation (REC-011) ===
[PASS] manual-compact-checkpoint
  ok - manual /compact PreCompact flush stamps the checkpoint :: lastCheckpointAt 2026-08-28T20:05:00Z -> 2026-08-29T05:34:00.148Z
  ok - PreCompact records the machine resume hint :: nextActions=[resume-from-precompact-checkpoint,...]
  ok - session.md carries the PreCompact resume block (trigger manual) :: block=true
  ok - ledger.md records PRECOMPACT_CHECKPOINT :: ledger lines=2
  ok - PostCompact records the post-compact cadence event (exit 0, stamp advances) :: exit=0 ...
  ok - PostCompact does not clobber the PreCompact nextActions :: nextActions=[...]
  ok - recovery marker records the compaction with checkpoint_ok :: checkpoint_ok=true trigger=manual
  ok - post-compact stdout re-injects the disk-truth read order :: stdout lines=1
[PASS] resumed-session-inject-and-read
  ok - SessionStart (source compact) injects the recovery context block :: source=compact context 36 lines
  ok - injected context points the session at the durable state files :: ...
  ok - injected context carries the duplicate-prevention rule :: duplicate-prevention present=true
  ok - injected context names the ACTIVE task (never re-dispatch) :: REC-011 ...
  ok - fresh session reads the task map from state/checkpoint.json :: reloaded buckets ready=2 active=2 qc=1 blocked=1 mergeQueue=1
  ok - resume view holds the pre-compact resume hint :: nextActions=[...]
  ok - recovery marker points the resumed session at the read order :: read order entries=12
[PASS] no-data-loss-across-compaction
  ok - PreCompact flush preserves the legacy snake_case fields (SHAs, wave, buckets) :: main_sha=kept wave=1
  ok - task-id buckets survive compaction in the machine contract :: ready=2 active=2 qc=1 blocked=1 mergeQueue=1
  ok - camelCase truth (SHAs, wave) preserved through the full sequence :: main_sha=kept wave=1
  ok - pre-existing next-action hints preserved through the flush :: before=[...] after=[resume-from-precompact-checkpoint,...]
  ok - session.md content outside the marker block survives :: preserved=true
  ok - ledger.md keeps prior lines and stays append-only :: lines 1 -> 2
  ok - fresh session reconstructs the exact pre-compact task map :: active=2/2 ready=2/2 ...
result: PASS (scratch: /var/folders/.../mmcs-compact-sim-XXXX)
```

Exit code: `0` when every scenario passed, `1` otherwise.

## Scenario 1 — manual /compact updates the checkpoint

Spec §32 ("manual /compact updates the checkpoint") + spec §28 cadence.
Claude Code fires **PreCompact** before a (manual or auto) compaction and
**PostCompact** after it. The simulation drives the real hooks:

1. **PreCompact** (REC-002 `runPreCompact`, trigger `manual`) — the
   save-first-compact-second flush: checkpoint lock → `state/checkpoint.json`
   (legacy-aware read + normalize + atomic write, both key styles refreshed) →
   `session.md` marker block → `ledger.md` PRECOMPACT_CHECKPOINT line. The
   machine resume hint (`resume-from-precompact-checkpoint`) plus any
   custom /compact instructions land in `nextActions`.
2. **PostCompact** (REC-003 `runPostCompact`) records the spec §28
   post-compact cadence event through the checkpoint wiring, refreshes
   `state/recovery.json` (marker: `checkpoint_ok`, trigger), and re-injects
   the disk-truth read order on stdout. It deliberately does not clobber the
   PreCompact `nextActions`.

Asserted: the checkpoint stamp advances across the sequence, session.md
carries the trigger-tagged resume block, the ledger gains the
`PRECOMPACT_CHECKPOINT` line, the marker records the compaction.

## Scenario 2 — simulated new/resumed session injects + reads state

Runbook §5.2 resume read order. After one full PreCompact→PostCompact cycle:

1. **Inject** — `runSessionStart` with `source: "compact"` (what Claude Code
   injects on a compact-mode session start) produces the
   `<session-start-context>` block: recovery read-order pointers
   (`recovery.md`, `state/checkpoint.json`), the duplicate-prevention rule,
   and the ACTIVE task names (never re-dispatch).
2. **Read** — a brand-new `CheckpointService` (zero in-memory memory) calls
   `loadExisting()` on the durable file; `toResumeView()` reconstructs the
   ready/active/qc/blocked/mergeQueue buckets. Disk is the only memory across
   the compaction boundary — exactly like a real resumed session.

Also proven (unit-level): `loadExisting` on a repo with no checkpoint
rejects — a fresh session without durable state fails loudly, never silently
dispatches on an empty map.

## Scenario 3 — no data loss across compaction

Every semantic value recorded before compaction survives the whole
PreCompact→PostCompact sequence in the on-disk truth:

- **Task-id buckets** (ready/active/qc/blocked/mergeQueue) — same set before
  and after, in the machine contract (`readyTaskIds`, …).
- **Legacy snake_case fields** — `current_main_sha`,
  `current_integration_sha`, `active_dependency_wave`, `*_task_ids`: the
  PreCompact flush must keep the bootstrap aliases fresh (REC-002 contract;
  the real committed `state/checkpoint.json` is snake_case).
- **nextActions hints** — pre-existing hints survive; the flush may only ADD
  the resume hint and the compact instructions.
- **session.md** — content OUTSIDE the PreCompact marker block survives
  byte-for-byte; the block itself is idempotent (exactly one block after
  repeated flushes).
- **ledger.md** — prior lines kept, lines only appended.
- A fresh `CheckpointService` → `toResumeView` reconstructs the exact
  pre-compact task map from disk alone.

### The dual-shape read contract

The control plane legitimately produces two checkpoint shapes: the bootstrap
doc is snake_case, and `CheckpointService.save` persists the camelCase
machine contract. PreCompact's flush preserves both (its `addSnakeAliases`
mirror); PostCompact's cadence write persists camelCase only. The simulator's
`snapshotSandbox` therefore reads camelCase-first with snake fallback —
reading a single style would manufacture a false data-loss failure (or hide
a real one). `pickField()` encodes that contract and is unit-tested.

## Discriminating power

A simulation that cannot fail is not evidence. The suite proves the negative
directions too:

- `loadExisting` throws on a checkpoint-less repo (fresh session needs the file).
- The stamp must CHANGE from the seeded legacy timestamp.
- Hints must never shrink; ledger lines must only grow.
- Marker-block upsert must never duplicate the block across repeated flushes.

## Files

- `scripts/orchestration/compact-sim.ts` — the simulation + CLI entry.
- `scripts/orchestration/compact-sim.test.ts` — the vitest suite (same
  scenarios plus unit assertions).
- Real subsystem code under test (owned by other tasks, not modified here):
  `scripts/hooks/pre-compact.ts` (REC-002), `scripts/hooks/post-compact.ts`
  (REC-003), `scripts/hooks/session-start.ts` (REC-004),
  `packages/core/src/recovery/` (CORE-014).
