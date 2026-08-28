/// <reference types="node" />
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CheckpointSchemaError,
  CHECKPOINT_FILE,
  emptyCheckpoint,
  uniqueIds,
  type CheckpointState,
  type TaskBucket,
} from "../../packages/core/src/recovery/index.js";
import { CheckpointService, toResumeView } from "../../packages/core/src/recovery/checkpoint.js";

export { CHECKPOINT_FILE, CheckpointSchemaError, emptyCheckpoint, uniqueIds, toResumeView };
export type { CheckpointState, TaskBucket };
export { CheckpointService };

/**
 * REC-001 — Checkpoint service wiring (spec.md §28 "Durable checkpoint";
 * runbook §5 checkpoint cadence; todo.md TASK-REC-001).
 *
 * CORE-014 owns the CheckpointService itself (`packages/core/src/recovery/`).
 * This module is the WIRING layer that enforces the spec §28 checkpoint
 * cadence around it:
 *
 *   every material task transition · before/after compaction ·
 *   before/after batch merge · before planned restart · session end ·
 *   after recovery · every watchdog cycle
 *
 * It adds the two guarantees the bare service leaves to callers:
 * - **Cross-process serialization.** The service only serializes writers
 *   inside one process. Every wiring write takes `state/locks/checkpoint.lock`
 *   (create-exclusive + stale-takeover), re-reads the document from disk
 *   inside the lock, applies the mutation, and persists through the service's
 *   atomic temp+fsync+rename write. Two processes racing can no longer
 *   lose each other's update, and the file on disk is at every instant a
 *   complete checkpoint — never a partial write.
 * - **Named cadence events.** Callers may only checkpoint through one of the
 *   spec §28 events below; an unknown event is a wiring defect and throws.
 *   Each write is journaled (bounded, in-memory) with its trigger so QC and
 *   the watchdog can prove cadence was followed.
 *
 * Also owns the checkpoint side of the `state/` writers: `syncFromStateFiles()`
 * reconciles the task-id buckets from `state/tasks.json` (the human/builder
 * statuses) into the machine checkpoint.
 */

/** Spec §28 checkpoint cadence events — the only legal write triggers. */
export const CADENCE_EVENTS = [
  "material-transition",
  "pre-compact",
  "post-compact",
  "pre-batch-merge",
  "post-batch-merge",
  "pre-restart",
  "session-end",
  "after-recovery",
  "watchdog-cycle",
] as const;

export type CadenceEvent = (typeof CADENCE_EVENTS)[number];

export function isCadenceEvent(value: unknown): value is CadenceEvent {
  return (
    typeof value === "string" && (CADENCE_EVENTS as readonly string[]).includes(value)
  );
}

/** Human-readable cadence contract (spec §28), for logs and tests. */
export function describeCadence(): { event: CadenceEvent; requirement: string }[] {
  return [
    { event: "material-transition", requirement: "every material task transition" },
    { event: "pre-compact", requirement: "before compaction (save-first, compact-second)" },
    { event: "post-compact", requirement: "after compaction" },
    { event: "pre-batch-merge", requirement: "before batch merge" },
    { event: "post-batch-merge", requirement: "after batch merge" },
    { event: "pre-restart", requirement: "before planned restart" },
    { event: "session-end", requirement: "session end" },
    { event: "after-recovery", requirement: "after recovery" },
    { event: "watchdog-cycle", requirement: "every watchdog cycle" },
  ];
}

export interface CadenceJournalEntry {
  at: string;
  trigger: CadenceEvent;
  detail?: string;
}

/** Thrown when the checkpoint lock cannot be acquired (live contention). */
export class CheckpointLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointLockError";
  }
}

/** Thrown for invalid CLI/arguments usage of the wiring module. */
export class CheckpointUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointUsageError";
  }
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;
const JOURNAL_LIMIT = 200;

export interface CheckpointLockOptions {
  /** Max ms to wait for a live holder before failing (default 10s). */
  timeoutMs?: number;
  /** Lock age in ms after which a holder is presumed dead (default 60s). */
  staleMs?: number;
}

/**
 * Shared/exclusive cross-process lock over `state/locks/checkpoint.lock`.
 * Protocol: create-exclusive with `{pid, at, token}` inside; on EEXIST either
 * wait (holder alive) or take over (older than `staleMs` — the holder died
 * between create and unlink). Release unlinks the lock ONLY when the stored
 * token still matches ours, so a stale-takeover never deletes a lock another
 * live process legitimately holds.
 */
export async function withCheckpointLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
  opts?: CheckpointLockOptions,
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  const locksDir = join(repoRoot, "state", "locks");
  await mkdir(locksDir, { recursive: true });
  const lockPath = join(locksDir, "checkpoint.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      // Age the lock by its mtime, never by parsing its content: between
      // create-exclusive and the content write the file is briefly empty,
      // and treating that as "litter" would let two writers in. A lock
      // younger than staleMs is either a live holder or a writer that died
      // moments ago — wait it out either way.
      let ageMs = 0;
      try {
        const info = await stat(lockPath);
        ageMs = Date.now() - info.mtimeMs;
      } catch {
        ageMs = staleMs; // vanished between EEXIST and stat — retry now
      }
      if (ageMs < staleMs) {
        if (Date.now() > deadline) {
          throw new CheckpointLockError(
            `timed out waiting for checkpoint lock at ${lockPath}`,
          );
        }
        await sleep(LOCK_POLL_MS);
        continue;
      }
      // Stale: take over. A concurrent takeover may win the unlink/create
      // race — the loop retries either way.
      await unlink(lockPath).catch(() => undefined);
    }
  }
  try {
    if (handle) {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
          token,
        })}\n`,
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
    }
    return await fn();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    // Release only our own lock: re-read and compare tokens so a
    // stale-takeover by another process is never clobbered by us.
    try {
      const raw = await readFile(lockPath, "utf8");
      const holder = JSON.parse(raw) as { token?: string };
      if (holder.token === token) {
        await unlink(lockPath);
      }
    } catch {
      /* lock already gone or unreadable — nothing to release */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builder/QC status vocabulary in state/tasks.json → checkpoint buckets. */
export const STATUS_TO_BUCKET: Record<string, TaskBucket | null> = {
  READY: "ready",
  ACTIVE: "active",
  QC_FIXING: "active",
  BUILDER_DONE: "qc",
  PASS: "mergeQueue",
  BLOCKED: "blocked",
  MERGED: null, // merged tasks leave every bucket
};

export class CheckpointWiring {
  readonly repoRoot: string;
  readonly service: CheckpointService;
  private readonly lockOptions?: CheckpointLockOptions;
  private journal: CadenceJournalEntry[] = [];

  constructor(
    repoRoot: string,
    opts?: { service?: CheckpointService; lockOptions?: CheckpointLockOptions },
  ) {
    if (!repoRoot || repoRoot.trim() === "") {
      throw new CheckpointUsageError("repoRoot is required");
    }
    this.repoRoot = repoRoot;
    this.lockOptions = opts?.lockOptions;
    this.service =
      opts?.service ?? new CheckpointService(repoRoot);
  }

  /** Bounded audit trail of cadence writes in this process. */
  getJournal(): readonly CadenceJournalEntry[] {
    return this.journal;
  }

  /**
   * Run one cadence write under the checkpoint lock. The service cache is
   * invalidated first so the mutation is applied to the on-disk truth, not a
   * possibly stale in-process copy (another process may have written since).
   */
  private async run(
    trigger: CadenceEvent,
    fn: () => Promise<CheckpointState>,
    detail?: string,
  ): Promise<CheckpointState> {
    return withCheckpointLock(
      this.repoRoot,
      async () => {
        this.service.invalidate();
        const next = await fn();
        this.journal.push({ at: next.lastCheckpointAt, trigger, detail });
        if (this.journal.length > JOURNAL_LIMIT) {
          this.journal.splice(0, this.journal.length - JOURNAL_LIMIT);
        }
        return next;
      },
      this.lockOptions,
    );
  }

  /** Full-snapshot persist for callers that own a complete state object. */
  async checkpoint(trigger: CadenceEvent, next: CheckpointState): Promise<CheckpointState> {
    return this.run(trigger, () => this.service.save(next));
  }

  /**
   * Generic cadence write for callers (hooks, watchdog, merge loop) that need
   * a one-off mutation with a named cadence trigger: runs under the
   * checkpoint lock against the on-disk truth and persists atomically.
   */
  async write(
    trigger: CadenceEvent,
    mutate: (state: CheckpointState) => CheckpointState | void,
    detail?: string,
  ): Promise<CheckpointState> {
    return this.run(trigger, () => this.service.update(mutate), detail);
  }

  /** Spec §28: every material task transition checkpoints. */
  async materialTransition(taskId: string, bucket: TaskBucket | null): Promise<CheckpointState> {
    if (!taskId || taskId.trim() === "") {
      throw new CheckpointUsageError("materialTransition requires a taskId");
    }
    return this.run(
      "material-transition",
      () => this.service.setTaskState(taskId, bucket),
      `${taskId}->${bucket ?? "removed"}`,
    );
  }

  /** Spec §28: save-first, compact-second. */
  async preCompact(nextActions?: string[]): Promise<CheckpointState> {
    return this.run("pre-compact", () =>
      this.service.update((state) => {
        if (nextActions) state.nextActions = uniqueIds(nextActions);
      }),
    );
  }

  /** Spec §28: checkpoint again after compaction (fresh session may follow). */
  async postCompact(nextActions?: string[]): Promise<CheckpointState> {
    return this.run("post-compact", () =>
      this.service.update((state) => {
        if (nextActions) state.nextActions = uniqueIds(nextActions);
      }),
    );
  }

  /** Spec §28: checkpoint immediately before a batch merge cycle. */
  async preBatchMerge(integrationSha?: string): Promise<CheckpointState> {
    return this.run("pre-batch-merge", () =>
      this.service.update((state) => {
        if (integrationSha) state.currentIntegrationSha = integrationSha;
      }),
    );
  }

  /** Spec §28: checkpoint after a batch merge; clear the consumed queue. */
  async postBatchMerge(
    lastKnownGoodCommit?: string,
    integrationSha?: string,
  ): Promise<CheckpointState> {
    return this.run("post-batch-merge", () =>
      this.service.update((state) => {
        state.lastMergeAt = new Date().toISOString();
        state.mergeQueueTaskIds = [];
        if (lastKnownGoodCommit) state.lastKnownGoodCommit = lastKnownGoodCommit;
        if (integrationSha) state.currentIntegrationSha = integrationSha;
      }),
    );
  }

  /** Spec §28: before a planned restart. */
  async preRestart(nextActions?: string[]): Promise<CheckpointState> {
    return this.run("pre-restart", () =>
      this.service.update((state) => {
        if (nextActions) state.nextActions = uniqueIds(nextActions);
      }),
    );
  }

  /** Spec §28: final checkpoint at session end. */
  async sessionEnd(nextActions?: string[]): Promise<CheckpointState> {
    return this.run("session-end", () =>
      this.service.update((state) => {
        if (nextActions) state.nextActions = uniqueIds(nextActions);
      }),
    );
  }

  /** Spec §28: checkpoint right after a recovery pass completes. */
  async afterRecovery(nextActions?: string[]): Promise<CheckpointState> {
    return this.run("after-recovery", () =>
      this.service.update((state) => {
        if (nextActions) state.nextActions = uniqueIds(nextActions);
      }),
    );
  }

  /** Spec §28: every watchdog cycle updates the checkpoint atomically. */
  async watchdogCycle(
    opts?: { nextActions?: string[]; workflowIds?: string[]; agentIds?: string[] },
  ): Promise<CheckpointState> {
    return this.run("watchdog-cycle", () =>
      this.service.update((state) => {
        state.lastWatchdogAt = new Date().toISOString();
        if (opts?.nextActions) state.nextActions = uniqueIds(opts.nextActions);
        if (opts?.workflowIds) state.activeWorkflowIds = uniqueIds(opts.workflowIds);
        if (opts?.agentIds) state.activeAgentIds = uniqueIds(opts.agentIds);
      }),
    );
  }

  /**
   * Reconcile the checkpoint task buckets from `state/tasks.json` (the
   * builder/QC status vocabulary) — the checkpoint side of the `state/`
   * writers owned by REC-001. Returns the ids that could not be mapped.
   */
  async syncFromTasks(tasks: readonly { id: string; status: string }[]): Promise<{
    state: CheckpointState;
    unmapped: string[];
  }> {
    const unmapped: string[] = [];
    const buckets: Record<TaskBucket, string[]> = {
      ready: [],
      active: [],
      qc: [],
      blocked: [],
      mergeQueue: [],
    };
    for (const task of tasks) {
      if (!task?.id) continue;
      const bucket = STATUS_TO_BUCKET[task.status];
      if (bucket === undefined) {
        unmapped.push(task.id);
        continue;
      }
      if (bucket !== null) buckets[bucket].push(task.id);
    }
    const state = await this.run("material-transition", () =>
      this.service.update((state) => {
        state.readyTaskIds = uniqueIds(buckets.ready);
        state.activeTaskIds = uniqueIds(buckets.active);
        state.qcTaskIds = uniqueIds(buckets.qc);
        state.blockedTaskIds = uniqueIds(buckets.blocked);
        state.mergeQueueTaskIds = uniqueIds(buckets.mergeQueue);
      }),
    );
    return { state, unmapped };
  }

  /** Resume view convenience passthrough (runbook §5 reload). */
  async resumeView() {
    return toResumeView(await this.service.loadExisting());
  }
}

// ---------------------------------------------------------------------------
// CLI — lets hooks (REC-002..007) and the watchdog/merge loops (REC-008/009)
// enforce the cadence without importing TypeScript: `npx tsx
// scripts/orchestration/checkpoint.ts --event watchdog-cycle ...`
// ---------------------------------------------------------------------------

export interface CliOptions {
  event?: CadenceEvent;
  task?: string;
  bucket?: TaskBucket | null;
  nextActions?: string[];
  integrationSha?: string;
  lastKnownGoodCommit?: string;
  workflowIds?: string[];
  agentIds?: string[];
  repoRoot?: string;
  sync?: boolean;
  selftest?: boolean;
  help?: boolean;
}

const USAGE = `Usage: npx tsx scripts/orchestration/checkpoint.ts [options]

Options:
  --event <event>         One of: ${CADENCE_EVENTS.join(", ")}
  --task <id>             Task id (material-transition)
  --bucket <bucket>       ready | active | qc | blocked | mergeQueue (material-transition; omit to remove)
  --next-actions <a,b,c>  Replacement next-actions list
  --integration-sha <sha> Integration head SHA (pre/post-batch-merge)
  --known-good <sha>      Last known good commit (post-batch-merge)
  --workflow-ids <a,b>    Active workflow ids (watchdog-cycle)
  --agent-ids <a,b>       Active agent ids (watchdog-cycle)
  --repo-root <path>      Repo root (default: cwd)
  --sync                  Also reconcile task buckets from state/tasks.json
  --selftest              Run the built-in integration self-test and exit 0/2
  --help                  This help
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      if (i >= argv.length) {
        throw new CheckpointUsageError(`missing value for ${arg}`);
      }
      return argv[i] as string;
    };
    switch (arg) {
      case "--event":
        opts.event = next() as CadenceEvent;
        break;
      case "--task":
        opts.task = next();
        break;
      case "--bucket": {
        const raw = next();
        if (raw === "none" || raw === "remove") {
          opts.bucket = null;
        } else {
          opts.bucket = raw as TaskBucket;
        }
        break;
      }
      case "--next-actions":
        opts.nextActions = (next() as string).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--integration-sha":
        opts.integrationSha = next();
        break;
      case "--known-good":
        opts.lastKnownGoodCommit = next();
        break;
      case "--workflow-ids":
        opts.workflowIds = (next() as string).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--agent-ids":
        opts.agentIds = (next() as string).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--repo-root":
        opts.repoRoot = next();
        break;
      case "--sync":
        opts.sync = true;
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new CheckpointUsageError(`unknown option ${argv[i]}`);
    }
  }
  return opts;
}

async function readTasksJson(repoRoot: string): Promise<{ id: string; status: string }[]> {
  const filePath = join(repoRoot, "state", "tasks.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { items?: { id?: string; status?: string }[] };
  return (parsed.items ?? [])
    .filter((item): item is { id: string; status: string } =>
      typeof item?.id === "string" && typeof item?.status === "string")
    .map((item) => ({ id: item.id, status: item.status }));
}

/**
 * In-process integration self-test: full spec §28 cadence against a temp
 * repo root, concurrent writers racing through the lock, concurrent readers
 * proving atomicity (every observed file parses as a complete checkpoint),
 * and a final consistency sweep. Prints one line per check; exits 0 on PASS.
 */
export async function selftest(log: (line: string) => void = () => undefined): Promise<void> {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mmcs-checkpoint-selftest-"));
  const seen: string[] = [];
  try {
    const wiring = new CheckpointWiring(dir);

    // 1. Concurrent writers through the lock — all updates must survive.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        wiring.materialTransition(`SELFTEST-${i}`, i % 2 === 0 ? "ready" : "active"),
      ),
    );
    const afterWriters = JSON.parse(
      await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8"),
    ) as CheckpointState;
    for (let i = 0; i < 8; i += 1) {
      const id = `SELFTEST-${i}`;
      const present =
        afterWriters.readyTaskIds.includes(id) || afterWriters.activeTaskIds.includes(id);
      if (!present) {
        throw new Error(`concurrent writer lost update for ${id}`);
      }
    }
    seen.push("concurrent-writers: all 8 updates present");

    // 2. Full cadence — every spec §28 event writes a valid checkpoint.
    await wiring.preCompact(["resume-from-precompact-checkpoint"]);
    await wiring.materialTransition("SELFTEST-0", "qc");
    await wiring.preBatchMerge("0".repeat(40));
    await wiring.postBatchMerge("1".repeat(40), "2".repeat(40));
    await wiring.watchdogCycle({ nextActions: ["continue-build"] });
    await wiring.sessionEnd(["resume-with-session-end-checkpoint"]);
    await wiring.afterRecovery(["task-map-reconciled"]);
    await wiring.preRestart(["restart-imminent"]);
    const final = await wiring.postCompact(["compaction-checkpoint-written"]);
    if (!final.lastWatchdogAt || !final.lastMergeAt) {
      throw new Error("cadence events did not stamp their timestamps");
    }
    if (!final.qcTaskIds.includes("SELFTEST-0")) {
      throw new Error("material transition bucket move lost");
    }
    if (final.mergeQueueTaskIds.length !== 0) {
      throw new Error("post-batch-merge must clear the merge queue");
    }
    seen.push("cadence: all spec §28 events persisted");

    // 3. Readers racing writers never observe a partial file.
    const reader = (async () => {
      for (let i = 0; i < 50; i += 1) {
        try {
          const raw = await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8");
          JSON.parse(raw);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
      }
    })();
    await Promise.all([
      reader,
      wiring.materialTransition("SELFTEST-1", "blocked"),
      wiring.materialTransition("SELFTEST-2", "mergeQueue"),
    ]);
    seen.push("atomicity: concurrent reads all parsed complete checkpoints");

    // 4. Temp-file hygiene after a clean run.
    const swept = await wiring.service.sweepTempFiles();
    if (swept !== 0) {
      throw new Error(`unexpected temp litter: ${swept}`);
    }
    seen.push("temp-sweep: clean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const line of seen) log(line);
  log("CHECKPOINT SELFTEST PASS");
}

/** Run the CLI; returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (opts.selftest) {
      await selftest((line) => io.stdout(`${line}\n`));
      return 0;
    }
    if (!opts.event && !opts.sync) {
      io.stderr(`nothing to do — pass --event, --sync or --selftest\n\n${USAGE}`);
      return 2;
    }
    if (opts.event && !isCadenceEvent(opts.event)) {
      io.stderr(`--event must be one of: ${CADENCE_EVENTS.join(", ")}\n`);
      return 2;
    }
    const repoRoot = opts.repoRoot ?? process.cwd();
    const wiring = new CheckpointWiring(repoRoot);

    if (opts.sync) {
      const tasks = await readTasksJson(repoRoot);
      const { state, unmapped } = await wiring.syncFromTasks(tasks);
      io.stdout(
        `synced buckets from state/tasks.json: ready=${state.readyTaskIds.length} active=${state.activeTaskIds.length} qc=${state.qcTaskIds.length} blocked=${state.blockedTaskIds.length} mergeQueue=${state.mergeQueueTaskIds.length}` +
          (unmapped.length ? ` (unmapped: ${unmapped.join(",")})` : "") +
          "\n",
      );
    }

    if (opts.event) {
      const event = opts.event as CadenceEvent;
      let state: CheckpointState;
      switch (event) {
        case "material-transition":
          if (!opts.task) {
            throw new CheckpointUsageError("--event material-transition requires --task");
          }
          state = await wiring.materialTransition(opts.task, opts.bucket ?? null);
          break;
        case "pre-compact":
          state = await wiring.preCompact(opts.nextActions);
          break;
        case "post-compact":
          state = await wiring.postCompact(opts.nextActions);
          break;
        case "pre-batch-merge":
          state = await wiring.preBatchMerge(opts.integrationSha);
          break;
        case "post-batch-merge":
          state = await wiring.postBatchMerge(opts.lastKnownGoodCommit, opts.integrationSha);
          break;
        case "pre-restart":
          state = await wiring.preRestart(opts.nextActions);
          break;
        case "session-end":
          state = await wiring.sessionEnd(opts.nextActions);
          break;
        case "after-recovery":
          state = await wiring.afterRecovery(opts.nextActions);
          break;
        case "watchdog-cycle":
          state = await wiring.watchdogCycle({
            nextActions: opts.nextActions,
            workflowIds: opts.workflowIds,
            agentIds: opts.agentIds,
          });
          break;
      }
      io.stdout(
        `checkpoint (${event}) written at ${state.lastCheckpointAt} -> ${join(repoRoot, "state", CHECKPOINT_FILE)}\n`,
      );
    }
    return 0;
  } catch (err) {
    io.stderr(`checkpoint error: ${(err as Error).message}\n`);
    return 2;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

// Run only when THIS module is the entry program (tsx script / CLI), never on
// import from tests or other modules. argv[1] is the executed file path.
// Sync-only on purpose: tsx transpiles TS entry scripts to CJS when there is
// no package.json "type": "module" in scope, and top-level await would fail.
import { realpathSync } from "node:fs";
try {
  if (
    process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
  ) {
    void main();
  }
} catch {
  /* not the entry script — no CLI run */
}