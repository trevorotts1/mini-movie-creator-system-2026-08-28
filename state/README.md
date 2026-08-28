# state/ — machine-readable orchestration state

Written by the MMCS orchestration agents; **not** hand-edited.

## checkpoint.json

The durable machine-readable checkpoint (runbook §5, PART II §4; spec.md §28
"Durable checkpoint"). Field set:

`schemaVersion, project, repoRoot, origin, upstream, integrationBranch,
lastCheckpointAt, lastMergeAt, lastWatchdogAt, currentWave, buildComplete,
activeWorkflowIds, readyTaskIds, blockedTaskIds, mergeQueueTaskIds,
lastKnownGoodCommit` (runbook §5 minimum) plus `activeTaskIds, qcTaskIds,
activeAgentIds, currentMainSha, currentIntegrationSha, lastFullRegressionAt,
nextActions` (PART II §4 superset).

- Written **atomically** (unique temp file + fsync + rename) by
  `@mmcs/core` `CheckpointService` (`packages/core/src/recovery/`). A
  `kill -9` at any instant leaves the previous valid checkpoint, never a
  partial file. Temp-file litter (only possible if the process died between
  temp creation and rename) is removed at startup by
  `CheckpointService.sweepTempFiles()`.
- JSON schema for the document: `state/checkpoint.schema.json` (schemaVersion 1).
- Update cadence: every material task transition, before/after compaction,
  before/after batch merge, before planned restart, session end, after
  recovery, every watchdog cycle.
- Reload: `CheckpointService.load()` → `toResumeView()` reconstructs the
  ready/active/qc/blocked/mergeQueue task-id buckets for resume.
- `state/locks/` is gitignored (lock files are runtime-only).
- `state/checkpoint.json` itself is generated at runtime and not committed;
  the schema + the writer code are the contract.