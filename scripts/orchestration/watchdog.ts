/// <reference types="node" />
/**
 * MMCS watchdog engine (runbook §7.1; spec.md §28 "Ten-minute loops" — watchdog
 * half; task REC-008).
 *
 * One cycle, exactly the runbook order:
 *   1.  acquire state/locks/watchdog.lock (exclusive; stale locks broken)
 *   2.  read checkpoint/tasks/workflows/agents JSON
 *   3.  query actual workflow/team/task state
 *   4.  query actual git worktrees/branches
 *   5.  count visible workflows
 *   6.  agents per workflow
 *   7.  fail workflow >10 agents
 *   8.  count global active agents
 *   9.  fail >500
 *   10. identify READY tasks with satisfied dependencies
 *   11. identify idle agents with compatible READY work
 *   12. refill slots immediately via visible dispatch
 *   13. identify stalled agents (no state/commit/log movement)
 *   14. ping/reassign/restart stalled
 *   15. identify duplicate tasks/ownership
 *   16. stop duplicate work
 *   17. every BUILDER_DONE task has active Sonnet QC/fixer
 *   18. QC findings being fixed not documented
 *   19. PASS tasks pushed to merge queue
 *   20. failed tests have owner
 *   21. blocked tasks contain real external dependency + next action
 *   22. update build-status.md with real counts
 *   23. append watchdog record to ledger
 *   24. atomic checkpoint update
 *   25. release lock
 *
 * "Refill under-capacity IMMEDIATELY — never merely report": the engine does
 * not stop at flagging an underfilled workflow; step 12 computes the concrete
 * refill plan (which workflow, how many agents, which task ids) and the caller
 * — the skill — dispatches it. The dry-run/selftest modes prove detection and
 * flagging; dispatch is the skill's visible-action step.
 *
 * Git, runtime process enumeration and dispatch are injected adapters; tests
 * drive real `git` against temp fixture repos and scripted runtime/dispatch
 * doubles. Real cycle runs `git worktree list` / `git branch --all` through
 * the real adapter.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_AGENTS_PER_WORKFLOW = 10;
export const MAX_GLOBAL_AGENTS = 500;
export const LOCK_PATH_REL = path.join("state", "locks", "watchdog.lock");
export const LOCK_STALE_MS_DEFAULT = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// State document shapes (mirror state/*.json as written by the planner and
// the batch merger — field-tolerant reads, never invented fields)
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string;
  title?: string;
  workflow?: string;
  dependsOn?: string[];
  owns?: string;
  branch?: string;
  worktree?: string;
  acceptance?: string;
  status?: string;
}

export interface WorkflowRecord {
  id?: string;
  name?: string;
  taskIds?: string[];
  /** Recorded count of agents this workflow currently has. */
  agentIds?: string[];
  state?: string;
}

export interface AgentRecord {
  id?: string;
  workflow?: string;
  taskId?: string;
  state?: string;
  /** Last movement evidence: ISO timestamp of last ledger/commit/log touch. */
  lastActivityAt?: string;
  model?: string;
  role?: string;
}

export interface QueueItem {
  taskId: string;
  branch?: string;
  status?: string;
}

export interface TasksDoc {
  schema_version?: number;
  updated_at?: string;
  items: TaskRecord[];
}

export interface WorkflowsDoc {
  schema_version?: number;
  updated_at?: string;
  items: WorkflowRecord[];
}

export interface AgentsDoc {
  schema_version?: number;
  updated_at?: string;
  items: AgentRecord[];
}

export interface MergeQueueDoc {
  schema_version?: number;
  updated_at?: string;
  items: QueueItem[];
}

export interface BuilderUpdateEvidence {
  taskId?: string;
  phase?: string;
  commit?: string;
  testsRun?: string;
  notes?: string;
  blockers?: unknown[];
}

export interface QcEvidence {
  taskId?: string;
  phase?: string;
  commit?: string;
  finalTestResult?: string;
  defectsFound?: number;
  defectsFixed?: number;
  blockers?: unknown[];
}

export interface CheckpointDoc {
  schemaVersion?: number;
  lastWatchdogAt?: string | null;
  /** snake_case mirror kept by older writers of the live checkpoint file. */
  last_watchdog_timestamp?: string | null;
  activeWorkflowIds?: string[];
  activeTaskIds?: string[];
  readyTaskIds?: string[];
  qcTaskIds?: string[];
  blockedTaskIds?: string[];
  mergeQueueTaskIds?: string[];
  activeAgentIds?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter contracts (injected so tests never touch the live repo/host)
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Short commit id; "" when unborn/detached with no commit. */
  sha: string;
}

export interface GitAdapter {
  /** Resolve a ref to a full sha; null when it does not resolve. */
  revParse(ref: string): Promise<string | null>;
  /** List `git worktree list --porcelain` parsed into entries. */
  listWorktrees(): Promise<WorktreeInfo[]>;
  /** List branches with `git branch --format` (short names, local+remote). */
  listBranches(): Promise<string[]>;
  /** `git log -1 --format=%cI <ref>` — ISO commit date of a rev. */
  commitDate(ref: string): Promise<string | null>;
  /** True when an origin remote exists. */
  hasOrigin(): Promise<boolean>;
}

/** The runtime's view of live agents — what the orchestrator can observe. */
export interface RuntimeAgent {
  id: string;
  workflow: string;
  taskId?: string;
  /** Agent heartbeat ISO timestamp; null = unknown. */
  lastActivityAt?: string | null;
  model?: string;
  role?: string;
}

export interface RuntimeAdapter {
  /** Live workflows (visibility: only what the orchestrator can actually see). */
  workflows(): Promise<RuntimeWorkflow[]>;
  /** Live agents across all workflows. */
  agents(): Promise<RuntimeAgent[]>;
}

export interface RuntimeWorkflow {
  id: string;
  agentIds: string[];
}

/** Dispatch plan for one underfilled workflow (step 12). */
export interface RefillEntry {
  workflow: string;
  /** Slots to open: max(0, 10 - current live agents). */
  slots: number;
  /** READY task ids with satisfied deps, preferring untaken ownership. */
  taskIds: string[];
  reason: string;
}

export interface DispatchRequest {
  workflow: string;
  taskIds: string[];
}

export interface DispatchAdapter {
  /** Visible dispatch of refill work; returns accepted task ids. */
  dispatch(request: DispatchRequest): Promise<{ accepted: string[] }>;
}

/** Ping a stalled agent (step 14) — visible nudge, never silent. */
export interface PingAdapter {
  ping(agentId: string, reason: string): Promise<void>;
}

/** Stop duplicate agent work (step 16) — kill the loser, keep the survivor. */
export interface KillAdapter {
  kill(agentId: string, reason: string): Promise<void>;
}

/** QC dispatch — ensure every BUILDER_DONE task has an active Sonnet QC/fixer. */
export interface QcDispatchAdapter {
  dispatch(taskId: string): Promise<{ accepted: boolean }>;
}

/** Merge-queue push — PASS tasks go to the batch-merge queue. */
export interface MergeQueueAdapter {
  push(taskId: string): Promise<{ accepted: boolean }>;
}

export interface WatchdogAdapters {
  git: GitAdapter;
  runtime: RuntimeAdapter;
  dispatch?: DispatchAdapter;
  ping?: PingAdapter;
  kill?: KillAdapter;
  qcDispatch?: QcDispatchAdapter;
  mergeQueue?: MergeQueueAdapter;
}

// ---------------------------------------------------------------------------
// Report shape (evidence: written to logs/watchdog/<ts>-watchdog.json)
// ---------------------------------------------------------------------------

export type ViolationKind =
  | "WORKFLOW_OVER_CAP"
  | "GLOBAL_OVER_CAP"
  | "STALLED_AGENT"
  | "DUPLICATE_TASK"
  | "DUPLICATE_AGENT"
  | "BUILDER_DONE_NO_QC"
  | "QC_UNDOCUMENTED"
  | "PASS_NOT_QUEUED"
  | "FAILED_TEST_NO_OWNER"
  | "BLOCKED_INCOMPLETE"
  | "WORKTREE_UNRECORDED"
  | "WORKTREE_MISSING"
  | "REFILL_NOT_DISPATCHED"
  | "INVALID_TASK_ID";

export interface Violation {
  kind: ViolationKind;
  severity: "info" | "warn" | "fail";
  message: string;
  taskId?: string;
  agentId?: string;
  workflow?: string;
}

export interface WatchdogReport {
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  lockAcquired: boolean;
  lockError?: string;
  selftest: boolean;
  recorded: {
    workflows: number;
    agents: number;
    tasks: number;
    ready: number;
    builderDone: number;
    pass: number;
    blocked: number;
    mergeQueue: number;
  };
  actual: {
    workflows: number;
    agents: number;
    worktrees: number;
    branches: number;
  };
  overCap: { workflow?: string; agents: number; limit: number }[];
  underCapacity: RefillEntry[];
  refilled: { workflow: string; taskIds: string[]; slots: number }[];
  stalled: { agentId: string; since: string }[];
  duplicates: Violation[];
  qcGaps: { taskId: string; reason: string }[];
  queuePushes: { taskId: string; accepted: boolean }[];
  violations: Violation[];
  violationsBySeverity: { info: number; warn: number; fail: number };
  /** True when a non-selftest cycle needs operator attention but nothing
   *  requires the engine to abort (the loop keeps running either way). */
  needsAttention: boolean;
}

// ---------------------------------------------------------------------------
// Locking — state/locks/watchdog.lock (runbook §7.1 step 1/25)
// ---------------------------------------------------------------------------

export interface LockHandle {
  token: string;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  staleMs?: number;
  now?: () => Date;
  /** Token recorded inside the lock for "is it still ours" checks. */
  token?: string;
}

/**
 * Exclusive lock via `open(path, "wx")`. A live lock (fresh) → EEXIST → throw.
 * A stale lock (older than `staleMs`) → broken (unlinked) and retaken.
 * Mirrors the batch-merge `merge.lock` behavior; separate namespace by design.
 */
export async function acquireWatchdogLock(
  repoRoot: string,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS_DEFAULT;
  const now = opts.now ?? (() => new Date());
  const token = opts.token ?? randomUUID();
  const lockDir = path.join(repoRoot, "state", "locks");
  const lockPath = path.join(repoRoot, LOCK_PATH_REL);
  await mkdir(lockDir, { recursive: true });
  const doc = { token, pid: process.pid, heldSince: now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      return {
        token,
        release: async () => {
          try {
            const raw = await readFile(lockPath, "utf8");
            if (JSON.parse(raw).token === token) {
              await unlink(lockPath);
            }
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
      }
      // EEXIST — check staleness once, then give up.
      let stale = false;
      try {
        const st = await stat(lockPath);
        stale = now().getTime() - st.mtimeMs > staleMs;
      } catch {
        // Lock vanished between open and stat: retry once.
        stale = false;
      }
      if (stale) {
        try {
          await unlink(lockPath);
        } catch {
          /* raced with another breaker — retry the open */
        }
        continue;
      }
      throw new Error(
        `could not acquire ${lockPath} — another watchdog cycle holds it`,
      );
    }
  }
  throw new Error(
    `could not acquire ${lockPath} — another watchdog cycle holds it`,
  );
}

// ---------------------------------------------------------------------------
// Small JSON helpers (self-contained copies: recovery util is core-owned,
// scripts cannot depend on package runtime without a build step)
// ---------------------------------------------------------------------------

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.trim() === "") {
    return null;
  }
  return JSON.parse(raw) as T;
}

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Append a ledger line: `timestamp | WATCHDOG | agent | STATE | note`. */
async function appendLedger(
  repoRoot: string,
  line: string,
): Promise<void> {
  const ledgerPath = path.join(repoRoot, "ledger.md");
  await appendFile(ledgerPath, `${line}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Real adapters (exec through the same shell the skill uses; never a bare
// `command -v` — run the tool and check rc)
// ---------------------------------------------------------------------------

export class RealGitAdapter implements GitAdapter {
  readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async revParse(ref: string): Promise<string | null> {
    try {
      const out = await this.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const out = await this.exec(["worktree", "list", "--porcelain"]);
    const entries: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> = {};
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) entries.push(cur as WorktreeInfo);
        cur = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) {
        cur.sha = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length);
      }
    }
    if (cur.path) entries.push(cur as WorktreeInfo);
    return entries;
  }

  async listBranches(): Promise<string[]> {
    // Tolerant like revParse: outside a git repo (rc=128) or unborn HEAD the
    // answer is "no branches", never a crash of the whole cycle.
    let out: string;
    try {
      out = await this.exec(["branch", "--format=%(refname:short)", "-a"]);
    } catch {
      return [];
    }
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async commitDate(ref: string): Promise<string | null> {
    try {
      const out = await this.exec(["log", "-1", "--format=%cI", ref]);
      const v = out.trim();
      return v === "" ? null : v;
    } catch {
      return null;
    }
  }

  async hasOrigin(): Promise<boolean> {
    try {
      const out = await this.exec(["remote"]);
      return out.split("\n").some((r) => r.trim() === "origin");
    } catch {
      return false;
    }
  }
}

export class RealRuntimeAdapter implements RuntimeAdapter {
  private readonly stateDir: string;

  /**
   * The orchestrator's visible-runtime records live in state/workflows.json +
   * state/agents.json (state/README.md: "machine-readable orchestration
   * state, written by the MMCS orchestration agents"). The default adapter
   * reflects the RECORDED visible state — the same source the orchestrator
   * fed. Field-tolerant: missing files → empty view, never a throw.
   */
  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  async workflows(): Promise<RuntimeWorkflow[]> {
    const doc = await readJsonOrNull<WorkflowsDoc>(
      path.join(this.stateDir, "workflows.json"),
    );
    const agentsDoc = await readJsonOrNull<AgentsDoc>(
      path.join(this.stateDir, "agents.json"),
    );
    const recordedAgents = agentsDoc?.items ?? [];
    const byWorkflow = new Map<string, string[]>();
    for (const a of recordedAgents) {
      if (!a.workflow) continue;
      const list = byWorkflow.get(a.workflow) ?? [];
      if (a.id) list.push(a.id);
      byWorkflow.set(a.workflow, list);
    }
    const items = doc?.items ?? [];
    const out: RuntimeWorkflow[] = [];
    for (const wf of items) {
      const id = wf.id ?? wf.name ?? "";
      if (id === "") continue;
      const fromDoc = Array.isArray(wf.agentIds) ? wf.agentIds : [];
      const fromAgents = byWorkflow.get(id) ?? [];
      out.push({
        id,
        agentIds: [...new Set([...fromDoc, ...fromAgents])],
      });
    }
    // Workflows present only in agents.json (no workflow doc) are still live
    // visible workflows.
    for (const [wf, ids] of byWorkflow) {
      if (out.some((w) => w.id === wf)) continue;
      out.push({ id: wf, agentIds: ids });
    }
    return out;
  }

  async agents(): Promise<RuntimeAgent[]> {
    const doc = await readJsonOrNull<AgentsDoc>(
      path.join(this.stateDir, "agents.json"),
    );
    return (doc?.items ?? []).map((a) => ({
      id: a.id ?? "",
      workflow: a.workflow ?? "",
      taskId: a.taskId,
      lastActivityAt: a.lastActivityAt ?? null,
      model: a.model,
      role: a.role,
    }));
  }
}

/** Real merge-queue push: appends the PASS task to state/merge-queue.json
 *  (the batch merger's machine-readable queue — runbook §7.2 step 2) via
 *  atomic temp+rename, skipping ids already present. */
export class RealMergeQueueAdapter implements MergeQueueAdapter {
  private readonly stateDir: string;
  private readonly now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.stateDir = stateDir;
    this.now = now;
  }

  async push(taskId: string): Promise<{ accepted: boolean }> {
    const filePath = path.join(this.stateDir, "merge-queue.json");
    const doc = await readJsonOrNull<MergeQueueDoc>(filePath);
    const items = Array.isArray(doc?.items) ? [...doc.items] : [];
    if (items.some((q) => q && q.taskId === taskId)) {
      return { accepted: true };
    }
    items.push({ taskId, status: "PASS" });
    await atomicWriteJson(filePath, {
      schema_version: doc?.schema_version ?? 1,
      updated_at: this.now().toISOString(),
      items,
    });
    return { accepted: true };
  }
}

// ---------------------------------------------------------------------------
// Pure policy helpers (deterministic, unit-tested; the engine composes them)
// ---------------------------------------------------------------------------

/** Is the task's dependency set satisfied by the given status map? */
export function dependenciesSatisfied(
  task: TaskRecord,
  statusOf: Map<string, string>,
): boolean {
  for (const dep of task.dependsOn ?? []) {
    const st = statusOf.get(dep);
    if (st !== "PASS" && st !== "MERGED" && st !== "DONE") {
      return false;
    }
  }
  return true;
}

/** READY tasks with all dependencies satisfied, ordered deterministically. */
export function readyTasksWithSatisfiedDeps(
  tasks: TaskRecord[],
  statusOf: Map<string, string>,
): TaskRecord[] {
  return tasks
    .filter((t) => (t.status ?? "") === "READY")
    .filter((t) => dependenciesSatisfied(t, statusOf))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Idle agents: live, recorded as active, but no evidence of movement. */
export function stalledAgents(
  agents: Array<{ id: string; lastActivityAt?: string | null }>,
  now: Date,
  staleMs: number,
): Array<{ agentId: string; since: string }> {
  const out: Array<{ agentId: string; since: string }> = [];
  for (const a of agents) {
    if (!a.lastActivityAt) {
      out.push({ agentId: a.id, since: now.toISOString() });
      continue;
    }
    const at = new Date(a.lastActivityAt).getTime();
    if (Number.isFinite(at) && now.getTime() - at > staleMs) {
      out.push({ agentId: a.id, since: a.lastActivityAt });
    }
  }
  return out;
}

/**
 * Refill plan: for each workflow, slots = 10 - live agents. Workflows with
 * live agents but spare slots are underfilled; workflows with zero live agents
 * AND zero ready tasks get no entry (nothing to do). Task ids are drawn from
 * the ready pool with satisfied deps, deduped, capped by the total slots.
 */
export function planRefills(
  liveWorkflows: RuntimeWorkflow[],
  ready: TaskRecord[],
  alreadyAssigned: Set<string>,
  limit: number,
): RefillEntry[] {
  const entries: RefillEntry[] = [];
  const used = new Set<string>(alreadyAssigned);
  const sorted = [...liveWorkflows].sort((a, b) => a.id.localeCompare(b.id));
  for (const wf of sorted) {
    const slots = Math.max(0, limit - wf.agentIds.length);
    if (slots <= 0) continue;
    const taskIds: string[] = [];
    for (const t of ready) {
      if (used.has(t.id)) continue;
      used.add(t.id);
      taskIds.push(t.id);
      if (taskIds.length >= slots) break;
    }
    if (taskIds.length === 0) continue; // nothing to refill — not an undercapacity entry
    entries.push({
      workflow: wf.id,
      slots,
      taskIds,
      reason: `workflow ${wf.id} at ${wf.agentIds.length}/${limit} - ${taskIds.length} ready task(s) refilling`,
    });
  }
  return entries;
}

/** Duplicate task ownership: a task id claimed by >1 live agent/workflow. */
export function duplicateOwnership(
  liveAgents: RuntimeAgent[],
  taskByAgent: Map<string, string>,
): Violation[] {
  const owners = new Map<string, string[]>();
  for (const a of liveAgents) {
    const taskId = a.taskId ?? taskByAgent.get(a.id);
    if (!taskId) continue;
    const list = owners.get(taskId) ?? [];
    list.push(a.id);
    owners.set(taskId, list);
  }
  const out: Violation[] = [];
  for (const [taskId, holders] of owners) {
    if (holders.length > 1) {
      out.push({
        kind: "DUPLICATE_TASK",
        severity: "warn",
        message: `task ${taskId} owned by ${holders.length} agents (${holders.join(", ")}) — keep the newest, kill the rest`,
        taskId,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  repoRoot: string;
  /** Path to the orchestrator's visible-runtime records (state dir). */
  stateDir?: string;
  /** Run the acceptance selftest: detect + flag undercapacity, mutate nothing. */
  selftest?: boolean;
  /** Dispatch refills (never in selftest; injectable in tests). */
  dispatch?: boolean;
  /** Write build-status.md + ledger + checkpoint (never in selftest). */
  persist?: boolean;
  /** Stale agent threshold (default 30 min). */
  agentStaleMs?: number;
  /** Lock age for staleness breaking (default 15 min). */
  lockStaleMs?: number;
  now?: () => Date;
  git?: GitAdapter;
  runtime?: RuntimeAdapter;
  dispatchAdapter?: DispatchAdapter;
  pingAdapter?: PingAdapter;
  killAdapter?: KillAdapter;
  qcDispatchAdapter?: QcDispatchAdapter;
  mergeQueueAdapter?: MergeQueueAdapter;
  /** Write ledger.md (default true when persist). */
  ledger?: boolean;
}

export const DEFAULT_REPO_ROOT = path.resolve(process.cwd());
export const AGENT_STALE_MS_DEFAULT = 30 * 60 * 1000;

export class WatchdogEngine {
  readonly config: Required<Pick<WatchdogConfig, "repoRoot">> & WatchdogConfig;
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly git: GitAdapter;
  private readonly runtime: RuntimeAdapter;

  constructor(config: WatchdogConfig) {
    if (!config.repoRoot || config.repoRoot.trim() === "") {
      throw new Error("repoRoot is required");
    }
    this.config = config;
    this.stateDir = config.stateDir ?? path.join(config.repoRoot, "state");
    this.now = config.now ?? (() => new Date());
    this.git = config.git ?? new RealGitAdapter(config.repoRoot);
    this.runtime = config.runtime ?? new RealRuntimeAdapter(this.stateDir);
  }

  private async loadDoc<T>(name: string, fallback: T): Promise<T> {
    const p = path.join(this.stateDir, name);
    const doc = await readJsonOrNull<T>(p);
    return doc ?? fallback;
  }

  /** One full watchdog cycle. */
  async run(): Promise<WatchdogReport> {
    const now = this.now();
    const startedAt = now.toISOString();
    const cycleId = `WD-${now.toISOString().replace(/[:.]/g, "-")}`;
    const report: WatchdogReport = {
      cycleId,
      startedAt,
      finishedAt: "",
      lockAcquired: false,
      selftest: this.config.selftest ?? false,
      recorded: { workflows: 0, agents: 0, tasks: 0, ready: 0, builderDone: 0, pass: 0, blocked: 0, mergeQueue: 0 },
      actual: { workflows: 0, agents: 0, worktrees: 0, branches: 0 },
      overCap: [],
      underCapacity: [],
      refilled: [],
      stalled: [],
      duplicates: [],
      qcGaps: [],
      queuePushes: [],
      violations: [],
      violationsBySeverity: { info: 0, warn: 0, fail: 0 },
      needsAttention: false,
    };

    // 1. lock (selftest deliberately skips: it must mutate nothing, and the
    // lock file is a mutation of the repo's state/ dir when the fixture root
    // is inside one)
    let lock: LockHandle | null = null;
    if (!this.config.selftest) {
      try {
        lock = await acquireWatchdogLock(this.config.repoRoot, {
          staleMs: this.config.lockStaleMs,
          now: this.now,
        });
        report.lockAcquired = true;
      } catch (err) {
        report.lockError = String((err as Error).message);
        return this.finish(report, now);
      }
    }

    try {
      // 2. read checkpoint/tasks/workflows/agents JSON
      const stateDir = this.stateDir;
      const tasksDoc = await this.loadDoc<TasksDoc>("tasks.json", { items: [] });
      const workflowsDoc = await this.loadDoc<WorkflowsDoc>("workflows.json", { items: [] });
      const agentsDoc = await this.loadDoc<AgentsDoc>("agents.json", { items: [] });
      const queueDoc = await this.loadDoc<MergeQueueDoc>("merge-queue.json", { items: [] });

      // Task ids are interpolated into file paths under state/task-updates/
      // (evidence reads) and passed to the merge-queue adapter. A malformed
      // or hostile id (`../..`, absolute, etc.) must never escape that dir or
      // reach an adapter — drop it from the cycle and flag it (§47 baseline).
      const safeTaskId = (id: unknown): id is string =>
        typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
      const rawTasks = tasksDoc.items ?? [];
      const badIds = rawTasks.filter((t) => !safeTaskId(t.id));
      for (const t of badIds) {
        report.violations.push({
          kind: "INVALID_TASK_ID",
          severity: "fail",
          message: `task record with id ${JSON.stringify(t.id)} is not a safe task id — excluded from the cycle`,
          taskId: typeof t.id === "string" ? t.id : undefined,
        });
      }
      const tasks = rawTasks.filter((t) => safeTaskId(t.id));
      const recordedWorkflows = workflowsDoc.items ?? [];
      const recordedAgents = agentsDoc.items ?? [];
      const queueTaskIds = new Set((queueDoc.items ?? []).map((q) => q.taskId));

      report.recorded = {
        workflows: recordedWorkflows.length,
        agents: recordedAgents.length,
        tasks: tasks.length,
        ready: tasks.filter((t) => t.status === "READY").length,
        builderDone: tasks.filter((t) => t.status === "BUILDER_DONE").length,
        pass: tasks.filter((t) => t.status === "PASS").length,
        blocked: tasks.filter((t) => t.status === "BLOCKED").length,
        mergeQueue: queueTaskIds.size,
      };

      // 3+4. query actual state (runtime + git)
      const liveWorkflows = await this.runtime.workflows();
      const liveAgents = await this.runtime.agents();
      let worktrees: WorktreeInfo[] = [];
      let branches: string[] = [];
      try {
        worktrees = await this.git.listWorktrees();
        branches = await this.git.listBranches();
      } catch (err) {
        report.violations.push({
          kind: "WORKTREE_UNRECORDED",
          severity: "warn",
          message: `git query failed: ${String((err as Error).message)}`,
        });
      }
      report.actual = {
        workflows: liveWorkflows.length,
        agents: liveAgents.length,
        worktrees: worktrees.length,
        branches: branches.length,
      };

      // 5+6. count visible workflows + agents per workflow
      for (const wf of liveWorkflows) {
        if (wf.agentIds.length > MAX_AGENTS_PER_WORKFLOW) {
          report.overCap.push({
            workflow: wf.id,
            agents: wf.agentIds.length,
            limit: MAX_AGENTS_PER_WORKFLOW,
          });
          report.violations.push({
            kind: "WORKFLOW_OVER_CAP",
            severity: "fail",
            message: `workflow ${wf.id} has ${wf.agentIds.length} agents > limit ${MAX_AGENTS_PER_WORKFLOW}`,
            workflow: wf.id,
          });
        }
      }

      // 8+9. global cap
      if (liveAgents.length > MAX_GLOBAL_AGENTS) {
        report.overCap.push({
          agents: liveAgents.length,
          limit: MAX_GLOBAL_AGENTS,
        });
        report.violations.push({
          kind: "GLOBAL_OVER_CAP",
          severity: "fail",
          message: `global active agents ${liveAgents.length} > limit ${MAX_GLOBAL_AGENTS}`,
        });
      }

      // 10. READY tasks with satisfied dependencies
      const statusOf = new Map<string, string>();
      for (const t of tasks) statusOf.set(t.id, t.status ?? "");
      const ready = readyTasksWithSatisfiedDeps(tasks, statusOf);

      // 11+12. idle agents with compatible READY work → refill under capacity
      const alreadyAssigned = new Set<string>();
      for (const a of liveAgents) {
        if (a.taskId) alreadyAssigned.add(a.taskId);
      }
      report.underCapacity = planRefills(
        liveWorkflows,
        ready,
        alreadyAssigned,
        MAX_AGENTS_PER_WORKFLOW,
      );
      if (this.config.dispatch && !report.selftest) {
        if (!this.config.dispatchAdapter) {
          // A real cycle that computes a refill plan but has no dispatch
          // adapter would silently "merely report" the undercapacity — the
          // one thing runbook §7.1 forbids. Fail loud instead of pretending
          // the refill happened.
          for (const entry of report.underCapacity) {
            if (entry.taskIds.length === 0) continue;
            report.violations.push({
              kind: "REFILL_NOT_DISPATCHED",
              severity: "fail",
              message: `workflow ${entry.workflow} under capacity by ${entry.slots} slots (tasks ${entry.taskIds.join(", ")}) but no dispatch adapter is wired in this cycle`,
            });
          }
        } else {
          for (const entry of report.underCapacity) {
            if (entry.taskIds.length === 0) continue;
            const res = await this.config.dispatchAdapter.dispatch({
              workflow: entry.workflow,
              taskIds: entry.taskIds,
            });
            report.refilled.push({
              workflow: entry.workflow,
              taskIds: res.accepted,
              slots: entry.slots,
            });
          }
        }
      }

      // 13. stalled agents
      report.stalled = stalledAgents(
        liveAgents,
        now,
        this.config.agentStaleMs ?? AGENT_STALE_MS_DEFAULT,
      );
      for (const s of report.stalled) {
        report.violations.push({
          kind: "STALLED_AGENT",
          severity: "warn",
          message: `agent ${s.agentId} stalled since ${s.since}`,
          agentId: s.agentId,
        });
      }
      // 14. ping/reassign/restart stalled
      if (this.config.pingAdapter && !report.selftest) {
        for (const s of report.stalled) {
          await this.config.pingAdapter.ping(s.agentId, `stalled since ${s.since}`);
        }
      }

      // 15+16. duplicates → stop the loser(s). Keep the NEWEST owner by
      // activity evidence (runbook §7.1 step 15: "keep the newest, kill the
      // rest"); live-agent order is arbitrary, so never trust it. Ties
      // (same/absent timestamp) fall back to agent id order for determinism.
      const taskByAgent = new Map<string, string>();
      for (const a of recordedAgents) {
        if (a.id && a.taskId) taskByAgent.set(a.id, a.taskId);
      }
      report.duplicates = duplicateOwnership(liveAgents, taskByAgent);
      report.violations.push(...report.duplicates);
      if (this.config.killAdapter && !report.selftest) {
        const owners = new Map<string, RuntimeAgent[]>();
        for (const a of liveAgents) {
          if (!a.taskId) continue;
          const list = owners.get(a.taskId) ?? [];
          list.push(a);
          owners.set(a.taskId, list);
        }
        for (const [taskId, holders] of owners) {
          if (holders.length < 2) continue;
          const ranked = [...holders].sort((x, y) => {
            const tx = Date.parse(x.lastActivityAt ?? "");
            const ty = Date.parse(y.lastActivityAt ?? "");
            if (Number.isFinite(tx) && Number.isFinite(ty) && tx !== ty) {
              return ty - tx; // newest first
            }
            if (Number.isFinite(tx) && !Number.isFinite(ty)) return -1;
            if (!Number.isFinite(tx) && Number.isFinite(ty)) return 1;
            return x.id.localeCompare(y.id);
          });
          for (const loser of ranked.slice(1)) {
            await this.config.killAdapter.kill(
              loser.id,
              `duplicate owner of ${taskId} — newer owner ${ranked[0]!.id} kept`,
            );
          }
        }
      }

      // 17. every BUILDER_DONE task has active Sonnet QC/fixer evidence
      for (const t of tasks) {
        if (t.status !== "BUILDER_DONE") continue;
        const evidencePath = path.join(stateDir, "task-updates", `${t.id}.qc.json`);
        const qc = await readJsonOrNull<QcEvidence>(evidencePath);
        const missingQc =
          !qc || qc.phase !== "PASS" || (qc.finalTestResult ?? "") !== "PASS";
        if (!missingQc) continue; // covered — no gap entry at all
        report.qcGaps.push({
          taskId: t.id,
          reason: "no Sonnet QC PASS evidence yet",
        });
        report.violations.push({
          kind: "BUILDER_DONE_NO_QC",
          severity: "warn",
          message: `task ${t.id} is BUILDER_DONE but has no Sonnet QC PASS evidence`,
          taskId: t.id,
        });
      }
      // Ensure an active QC dispatcher gets the gap list.
      if (this.config.qcDispatchAdapter && !report.selftest) {
        for (const g of report.qcGaps) {
          if (g.reason.startsWith("no Sonnet")) {
            await this.config.qcDispatchAdapter.dispatch(g.taskId);
          }
        }
      }

      // 18. QC findings being fixed must be documented in state/qc.md evidence
      for (const t of tasks) {
        if (t.status !== "QC_FIXING") continue;
        const evidencePath = path.join(stateDir, "task-updates", `${t.id}.qc.json`);
        const qc = await readJsonOrNull<QcEvidence>(evidencePath);
        const undocumented = !qc || (qc.finalTestResult ?? "") !== "FAIL";
        if (undocumented) {
          report.violations.push({
            kind: "QC_UNDOCUMENTED",
            severity: "warn",
            message: `task ${t.id} is QC_FIXING without documented FAIL evidence`,
            taskId: t.id,
          });
        }
      }

      // 19. PASS tasks → merge queue (push, never merely report)
      for (const t of tasks) {
        if (t.status !== "PASS") continue;
        if (queueTaskIds.has(t.id)) continue;
        let accepted = false;
        if (this.config.mergeQueueAdapter && !report.selftest) {
          const res = await this.config.mergeQueueAdapter.push(t.id);
          accepted = res.accepted;
        }
        report.queuePushes.push({ taskId: t.id, accepted });
        if (!accepted) {
          report.violations.push({
            kind: "PASS_NOT_QUEUED",
            severity: "warn",
            message: `task ${t.id} is PASS but could not be pushed to the merge queue`,
            taskId: t.id,
          });
        }
      }

      // 20. failed tests have owner
      for (const t of tasks) {
        if (t.status !== "BUILDER_DONE") continue;
        const evidencePath = path.join(stateDir, "task-updates", `${t.id}.builder.json`);
        const b = await readJsonOrNull<BuilderUpdateEvidence>(evidencePath);
        if (b && (b.testsRun ?? "").includes("FAIL")) {
          if (!t.workflow) {
            report.violations.push({
              kind: "FAILED_TEST_NO_OWNER",
              severity: "warn",
              message: `task ${t.id} has failing tests recorded but no owning workflow`,
              taskId: t.id,
            });
          }
        }
      }

      // 21. blocked tasks must be real external deps with next action
      for (const t of tasks) {
        if (t.status !== "BLOCKED") continue;
        const evidencePath = path.join(stateDir, "task-updates", `${t.id}.builder.json`);
        const b = await readJsonOrNull<BuilderUpdateEvidence>(evidencePath);
        const blockers = b?.blockers ?? [];
        const ok =
          Array.isArray(blockers) &&
          blockers.length > 0 &&
          blockers.every(
            (x) => typeof x === "string" && /^BLOCKED\b|^AWAITING\b|^WAITING ON\b|^PENDING\b/i.test(x.trim()),
          );
        if (!ok) {
          report.violations.push({
            kind: "BLOCKED_INCOMPLETE",
            severity: "warn",
            message: `task ${t.id} is BLOCKED but has no documented external dependency/next action`,
            taskId: t.id,
          });
        }
      }

      // Worktree/branch reconciliation vs recorded. Branch names drift
      // between conventions (`task/TASK-CORE-001-x` vs `task/CORE-001-x`),
      // so compare on the normalized task-id stem, not the raw string.
      const normBranch = (b: string): string =>
        b
          .replace(/^refs\/heads\//, "")
          .replace(/^refs\/remotes\//, "")
          .replace(/^origin\//, "")
          .replace(/^task\//, "")
          .replace(/^TASK-/, "");
      const liveBranchKeys = new Set<string>();
      for (const wt of worktrees) {
        if (!wt.branch && !wt.sha) continue;
        liveBranchKeys.add(normBranch(wt.branch ?? wt.sha ?? ""));
      }
      for (const b of branches) liveBranchKeys.add(normBranch(b));
      for (const t of tasks) {
        if (!t.branch) continue;
        const recordedBranch = t.branch;
        if (!liveBranchKeys.has(normBranch(recordedBranch))) {
          report.violations.push({
            kind: "WORKTREE_MISSING",
            severity: "info",
            message: `task ${t.id} records branch ${recordedBranch} but no live worktree/branch found`,
            taskId: t.id,
          });
        }
      }

      // 23. ledger record (never in selftest)
      if (this.config.persist && !report.selftest) {
        const line = `${now.toISOString()} | WATCHDOG | watchdog | CYCLE | ${cycleId} | workflows=${report.actual.workflows} agents=${report.actual.agents} violations=${report.violations.length} refills=${report.refilled.length}`;
        await appendLedger(this.config.repoRoot, line);
      }

      // 23b. cycle report evidence (runbook §7.1 "append logs/watchdog/")
      if (this.config.persist && !report.selftest) {
        const reportPath = path.join(
          this.config.repoRoot,
          "logs",
          "watchdog",
          `${now.toISOString().replace(/[:.]/g, "-")}-watchdog.json`,
        );
        await atomicWriteJson(reportPath, this.finish(report, now));
      }

      // 24. atomic checkpoint update — FORCE it: create the file when absent,
      // mirroring the snake_case live layout plus the camelCase core contract.
      if (this.config.persist && !report.selftest) {
        const checkpointPath = path.join(this.stateDir, "checkpoint.json");
        const cp =
          (await readJsonOrNull<CheckpointDoc>(checkpointPath)) ?? {
            schemaVersion: 1,
            lastWatchdogAt: null,
            last_watchdog_timestamp: null,
          };
        // CamelCase is the @mmcs/core CheckpointService contract
        // (packages/core/src/recovery/checkpoint-schema.ts); the live
        // state/checkpoint.json in this repo carries snake_case fields, so
        // write both to keep either reader fresh. No invented fields.
        cp.lastWatchdogAt = now.toISOString();
        cp.last_watchdog_timestamp = now.toISOString();
        await atomicWriteJson(checkpointPath, cp);
      }

      // 22. build-status.md with real counts — SURGICAL update: refresh the
      // header timestamp + the Task State Summary table rows in place,
      // preserving every other section (integration state, batch/regression
      // evidence) the batch merger owns. Never regen the whole dashboard here.
      if (this.config.persist && !report.selftest) {
        const statusPath = path.join(this.config.repoRoot, "build-status.md");
        const existing = await readFile(statusPath, "utf8").catch(() => "");
        const qcPending = report.qcGaps.filter((g) =>
          g.reason.startsWith("no Sonnet"),
        ).length;
        const counts: Record<string, number> = {
          "Total Tasks": report.recorded.tasks,
          "Ready Tasks": report.recorded.ready,
          "Blocked Tasks": report.recorded.blocked,
          "Building Tasks": report.actual.agents,
          "QC Tasks": report.recorded.builderDone - qcPending,
          "Merge Queue Tasks": report.recorded.mergeQueue,
          "Merged Tasks": tasks.filter((t) => t.status === "MERGED").length,
        };
        let updated: string;
        if (existing.trim() === "") {
          updated = `# Build Status Dashboard (build-status.md)\n\n**Project:** mini-movie-creator-system (MMCS)\n**Updated:** ${now.toISOString()}\n**Current Stage:** Watchdog cycle ${cycleId}\n\n---\n\n## 1. Task State Summary\n\n| Metric | Count |\n|---|---|\n${Object.entries(counts)
            .map(([k, v]) => `| ${k} | ${v} |`)
            .join("\n")}\n`;
        } else {
          const lines = existing.split("\n");
          const out = lines.map((line) => {
            const m = line.match(/^\*\*Updated:\*\* (.*)$/);
            if (m) return `**Updated:** ${now.toISOString()}`;
            const cm = line.match(/^\*\*Current Stage:\*\* (.*)$/);
            if (cm) return `**Current Stage:** Watchdog cycle ${cycleId}`;
            const row = line.match(/^\| (\w[\w ]*) \| (\d+) \|$/);
            if (row && counts[row[1]!] !== undefined) {
              return `| ${row[1]} | ${counts[row[1]!]} |`;
            }
            return line;
          });
          updated = out.join("\n");
        }
        await atomicWriteFile(statusPath, updated);
      }
    } finally {
      if (lock) {
        await lock.release();
      }
    }

    return this.finish(report, now);
  }

  private finish(report: WatchdogReport, now: Date): WatchdogReport {
    report.finishedAt = now.toISOString();
    report.violationsBySeverity = {
      info: report.violations.filter((v) => v.severity === "info").length,
      warn: report.violations.filter((v) => v.severity === "warn").length,
      fail: report.violations.filter((v) => v.severity === "fail").length,
    };
    report.needsAttention =
      report.violations.some((v) => v.severity === "warn" || v.severity === "fail") ||
      report.underCapacity.length > 0 ||
      report.stalled.length > 0 ||
      report.qcGaps.some((g) => g.reason.startsWith("no Sonnet"));
    return report;
  }
}
