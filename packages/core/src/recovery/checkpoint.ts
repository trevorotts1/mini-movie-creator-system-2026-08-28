import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOrNull,
} from "./atomic-write.js";
import {
  CHECKPOINT_FILE,
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaError,
  emptyCheckpoint,
  normalizeCheckpoint,
  uniqueIds,
  type CheckpointState,
} from "./checkpoint-schema.js";

export { CHECKPOINT_FILE, CHECKPOINT_SCHEMA_VERSION, CheckpointSchemaError };
export type { CheckpointState };
export { emptyCheckpoint, normalizeCheckpoint, uniqueIds };
export { atomicWriteFile, atomicWriteJson, readJsonFileOrNull } from "./atomic-write.js";

/**
 * Recovery checkpoint service (runbook §5, PART II §4; spec.md §28 "Durable
 * checkpoint").
 *
 * Owns the single `checkpoint.json` document at `<repoRoot>/state/`. Contract:
 * - Every write is atomic (unique temp file + fsync + rename), so a `kill -9`
 *   at any instant leaves either the previous valid checkpoint or the new
 *   one — never a partial file.
 * - Reads validate + normalize; a missing file yields a fresh empty
 *   checkpoint (first boot), corrupt content throws (external damage must
 *   surface, not silently reset).
 * - Reload reconstructs the task-id buckets (ready / active / qc / blocked /
 *   mergeQueue) exactly as recorded, plus workflow/agent ids and next actions.
 * - Mutators are narrow, named transitions (task moved between buckets,
 *   watchdog/merge heartbeat, etc.) so callers never hand-rewrite the whole
 *   document.
 * - An in-process write queue serializes concurrent updates in one process;
 *   cross-process callers use `state/locks/` (REC-001 wiring owns that).
 */
export class CheckpointService {
  readonly repoRoot: string;
  readonly filePath: string;
  private cached: CheckpointState | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(repoRoot: string, opts?: { filePath?: string }) {
    if (!repoRoot || repoRoot.trim() === "") {
      throw new CheckpointSchemaError("repoRoot is required");
    }
    this.repoRoot = repoRoot;
    this.filePath = opts?.filePath ?? join(repoRoot, "state", CHECKPOINT_FILE);
  }

  /** Load the checkpoint, or a fresh empty one when absent (first boot). */
  async load(): Promise<CheckpointState> {
    const raw = await readJsonFileOrNull<unknown>(this.filePath);
    if (raw === null) {
      this.cached = null;
      return emptyCheckpoint(this.repoRoot, this.repoRoot);
    }
    this.cached = normalizeCheckpoint(raw);
    return this.cached;
  }

  /**
   * Load strictly: missing file is an error instead of a fresh checkpoint.
   * Used on resume paths where a checkpoint MUST already exist.
   */
  async loadExisting(): Promise<CheckpointState> {
    const state = await this.load();
    if (this.cached === null) {
      throw new CheckpointSchemaError(
        `no checkpoint found at ${this.filePath} — run bootstrap first`,
      );
    }
    return state;
  }

  /** Current in-memory state; loads from disk on first access. */
  async get(): Promise<CheckpointState> {
    if (this.cached === null) {
      return this.load();
    }
    return this.cached;
  }

  /**
   * Persist a full snapshot atomically. Validates and stamps
   * lastCheckpointAt unless the caller set it explicitly.
   */
  async save(next: CheckpointState): Promise<CheckpointState> {
    const normalized = normalizeCheckpoint({
      ...next,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      lastCheckpointAt: next.lastCheckpointAt || new Date().toISOString(),
    });
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    // Serialize writes in-process: two concurrent saves must not interleave.
    const run = async () => {
      await atomicWriteFile(this.filePath, serialized);
      this.cached = normalized;
      return normalized;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  /** Mutate the current snapshot through `mutate` and persist atomically. */
  async update(
    mutate: (state: CheckpointState) => CheckpointState | void,
  ): Promise<CheckpointState> {
    const run = async () => {
      const current =
        this.cached ??
        normalizeCheckpoint(
          (await readJsonFileOrNull<unknown>(this.filePath)) ??
            emptyCheckpoint(this.repoRoot, this.repoRoot),
        );
      const draft: CheckpointState = structuredClone(current);
      const out = mutate(draft) ?? draft;
      const normalized = normalizeCheckpoint({
        ...out,
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        lastCheckpointAt: new Date().toISOString(),
      });
      await atomicWriteFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      this.cached = normalized;
      return normalized;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Move a task id from every other bucket into `bucket`. The buckets are
   * disjoint by construction; this is the transition primitive the watchdog
   * and merge loop call on every material task state change.
   */
  async setTaskState(
    taskId: string,
    bucket: TaskBucket | null,
  ): Promise<CheckpointState> {
    if (!taskId || taskId.trim() === "") {
      throw new CheckpointSchemaError("taskId is required");
    }
    return this.update((state) => {
      state.readyTaskIds = uniqueIds(
        state.readyTaskIds.filter((id) => id !== taskId),
      );
      state.activeTaskIds = uniqueIds(
        state.activeTaskIds.filter((id) => id !== taskId),
      );
      state.qcTaskIds = uniqueIds(state.qcTaskIds.filter((id) => id !== taskId));
      state.blockedTaskIds = uniqueIds(
        state.blockedTaskIds.filter((id) => id !== taskId),
      );
      state.mergeQueueTaskIds = uniqueIds(
        state.mergeQueueTaskIds.filter((id) => id !== taskId),
      );
      if (bucket !== null) {
        state[`${bucket}TaskIds`].push(taskId);
        state[`${bucket}TaskIds`] = uniqueIds(state[`${bucket}TaskIds`]);
      }
    });
  }

  /** Remove a task id entirely (e.g. task deleted / merged away). */
  async removeTask(taskId: string): Promise<CheckpointState> {
    return this.setTaskState(taskId, null);
  }

  /** Record a watchdog cycle (timestamp + optional next actions). */
  async markWatchdog(nextActions?: string[]): Promise<CheckpointState> {
    return this.update((state) => {
      state.lastWatchdogAt = new Date().toISOString();
      if (nextActions) state.nextActions = uniqueIds(nextActions);
    });
  }

  /** Record a completed batch merge. */
  async markMerge(lastKnownGoodCommit?: string): Promise<CheckpointState> {
    return this.update((state) => {
      state.lastMergeAt = new Date().toISOString();
      state.mergeQueueTaskIds = [];
      if (lastKnownGoodCommit) state.lastKnownGoodCommit = lastKnownGoodCommit;
    });
  }

  /** Record a successful full regression run. */
  async markFullRegression(): Promise<CheckpointState> {
    return this.update((state) => {
      state.lastFullRegressionAt = new Date().toISOString();
    });
  }

  /** Record workflow/agent presence (visible-runtime truth, runbook §9). */
  async setActiveRuntime(
    workflowIds: string[],
    agentIds: string[],
  ): Promise<CheckpointState> {
    return this.update((state) => {
      state.activeWorkflowIds = uniqueIds(workflowIds);
      state.activeAgentIds = uniqueIds(agentIds);
    });
  }

  /**
   * Crash-recovery sweep: remove temp-file litter left by a process that
   * died between temp-file creation and rename. Safe to run at startup.
   * Returns the number of files removed. Never touches `checkpoint.json`.
   */
  async sweepTempFiles(): Promise<number> {
    const dir = join(this.repoRoot, "state");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) {
        await rm(join(dir, entry), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Forget the in-memory cache; next access re-reads disk. */
  invalidate(): void {
    this.cached = null;
  }
}

export type TaskBucket = "ready" | "active" | "qc" | "blocked" | "mergeQueue";

/**
 * Reconstructed resume view: the task-id buckets plus convenience sets for
 * membership checks (recovery paths ask "is this id ready/blocked/queued").
 */
export interface ResumeView {
  checkpoint: CheckpointState;
  ready: Set<string>;
  blocked: Set<string>;
  mergeQueue: Set<string>;
  active: Set<string>;
  qc: Set<string>;
}

/** Rebuild a resume view from a checkpoint document (runbook §5 reload). */
export function toResumeView(state: CheckpointState): ResumeView {
  return {
    checkpoint: state,
    ready: new Set(state.readyTaskIds),
    blocked: new Set(state.blockedTaskIds),
    mergeQueue: new Set(state.mergeQueueTaskIds),
    active: new Set(state.activeTaskIds),
    qc: new Set(state.qcTaskIds),
  };
}