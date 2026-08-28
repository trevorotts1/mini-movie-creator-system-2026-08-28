import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_AGENTS_PER_WORKFLOW,
  MAX_GLOBAL_AGENTS,
  WatchdogEngine,
  RealGitAdapter,
  acquireWatchdogLock,
  dependenciesSatisfied,
  readyTasksWithSatisfiedDeps,
  stalledAgents,
  planRefills,
  duplicateOwnership,
  type TaskRecord,
  type RuntimeWorkflow,
  type RuntimeAgent,
  type WatchdogConfig,
  type GitAdapter,
} from "./watchdog.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(id: string, status: string, dependsOn: string[] = []): TaskRecord {
  return { id, status, dependsOn, workflow: "WF10" };
}

const noopGit: GitAdapter = {
  revParse: async () => null,
  listWorktrees: async () => [],
  listBranches: async () => [],
  commitDate: async () => null,
  hasOrigin: async () => false,
};

function baseConfig(
  root: string,
  overrides: Partial<WatchdogConfig> = {},
): WatchdogConfig {
  return {
    repoRoot: root,
    selftest: false,
    persist: false,
    dispatch: false,
    git: noopGit,
    runtime: { workflows: async () => [], agents: async () => [] },
    ...overrides,
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "watchdog-test-"));
  const stateDir = path.join(root, "state");
  await mkdir(path.join(stateDir, "task-updates"), { recursive: true });
  return root;
}

async function writeState(
  root: string,
  files: Record<string, unknown>,
): Promise<void> {
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  for (const [name, doc] of Object.entries(files)) {
    await writeFile(path.join(stateDir, name), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Pure policy helpers
// ---------------------------------------------------------------------------

describe("dependenciesSatisfied", () => {
  it("accepts empty deps", () => {
    const status = new Map<string, string>();
    expect(dependenciesSatisfied(task("T", "READY"), status)).toBe(true);
  });

  it("requires every dep PASS/MERGED", () => {
    const status = new Map([
      ["A", "PASS"],
      ["B", "BUILDER_DONE"],
    ]);
    expect(dependenciesSatisfied(task("T", "READY", ["A", "B"]), status)).toBe(false);
    status.set("B", "MERGED");
    expect(dependenciesSatisfied(task("T", "READY", ["A", "B"]), status)).toBe(true);
  });
});

describe("readyTasksWithSatisfiedDeps", () => {
  it("returns only READY tasks with satisfied deps, ordered", () => {
    const tasks = [
      task("T-C", "READY", ["T-A"]),
      task("T-A", "READY"),
      task("T-B", "BUILDER_DONE"),
      task("T-D", "READY", ["T-NONE"]),
    ];
    const status = new Map([
      ["T-A", "PASS"],
      ["T-B", "PASS"],
      ["T-D", "READY"],
      ["T-C", "READY"],
    ]);
    const ready = readyTasksWithSatisfiedDeps(tasks, status);
    // T-A ready (no deps) and T-C ready (dep T-A now PASS); T-B not READY;
    // T-D blocked by T-NONE.
    expect(ready.map((t) => t.id)).toEqual(["T-A", "T-C"]);
  });
});

describe("stalledAgents", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  it("flags missing activity and stale activity", () => {
    const agents = [
      { id: "A-1", lastActivityAt: "2026-08-28T11:00:00Z" }, // 1h ago
      { id: "A-2", lastActivityAt: "2026-08-28T11:59:00Z" }, // 1min ago
      { id: "A-3", lastActivityAt: null },
    ];
    const stalled = stalledAgents(agents, now, 30 * 60 * 1000);
    expect(stalled.map((s) => s.agentId).sort()).toEqual(["A-1", "A-3"]);
  });
});

describe("planRefills — under-capacity detection (acceptance)", () => {
  const ready = [task("R-1", "READY"), task("R-2", "READY"), task("R-3", "READY")];

  it("flags an underfilled workflow with ready tasks and fills slots", () => {
    const live: RuntimeWorkflow[] = [{ id: "WF10", agentIds: ["A-1"] }]; // 1/10
    const plan = planRefills(live, ready, new Set(), MAX_AGENTS_PER_WORKFLOW);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      workflow: "WF10",
      slots: 9,
    });
    expect(plan[0]!.taskIds).toContain("R-1");
    expect(plan[0]!.taskIds).toContain("R-2");
  });

  it("does not flag a full workflow", () => {
    const live: RuntimeWorkflow[] = [
      { id: "WF10", agentIds: Array.from({ length: 10 }, (_, i) => `A-${i}`) },
    ];
    expect(planRefills(live, ready, new Set(), 10)).toEqual([]);
  });

  it("does not assign a task already owned", () => {
    const live: RuntimeWorkflow[] = [{ id: "WF1", agentIds: ["A-1"] }];
    const plan = planRefills(live, ready, new Set(["R-1"]), 10);
    expect(plan[0]!.taskIds).not.toContain("R-1");
  });
});

describe("duplicateOwnership", () => {
  it("flags a task claimed by two agents", () => {
    const agents: RuntimeAgent[] = [
      { id: "A-1", taskId: "T-1", workflow: "W" },
      { id: "A-2", taskId: "T-1", workflow: "W" },
    ];
    const v = duplicateOwnership(agents, new Map());
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "DUPLICATE_TASK", taskId: "T-1" });
  });
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

describe("acquireWatchdogLock (runbook §7.1 step 1/25)", () => {
  it("acquires exclusively and releases", async () => {
    const root = await fixtureRoot();
    const l1 = await acquireWatchdogLock(root);
    await expect(acquireWatchdogLock(root)).rejects.toThrow(/another watchdog/);
    await l1.release();
    const l2 = await acquireWatchdogLock(root);
    await l2.release();
  });

  it("breaks a stale lock and retakes it", async () => {
    const root = await fixtureRoot();
    const stale = await acquireWatchdogLock(root);
    // Simulate age past staleness: staleMs: -1 makes any existing lock stale,
    // so the breaker must unlink it and retake (new token).
    const l = await acquireWatchdogLock(root, { staleMs: -1 });
    expect(l.token).not.toBe(stale.token);
    await l.release();
  });
});

// ---------------------------------------------------------------------------
// Engine cycle
// ---------------------------------------------------------------------------

describe("WatchdogEngine cycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await fixtureRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("acquires the lock, counts, and reports clean on a healthy cycle", async () => {
    await writeState(root, {
      "tasks.json": {
        schema_version: 1,
        items: [task("T-1", "MERGED")],
      },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
    });
    const engine = new WatchdogEngine(baseConfig(root));
    const report = await engine.run();
    expect(report.lockAcquired).toBe(true);
    expect(report.recorded.tasks).toBe(1);
    expect(report.violations).toEqual([]);
  });

  it("enforces max 10 agents per workflow (fails >10)", async () => {
    const live: RuntimeWorkflow[] = [
      { id: "WF10", agentIds: Array.from({ length: 11 }, (_, i) => `A-${i}`) },
    ];
    const engine = new WatchdogEngine(
      baseConfig(root, {
        runtime: {
          workflows: async () => live,
          agents: async () => live[0]!.agentIds.map((id) => ({ id, workflow: "WF10" })),
        },
      }),
    );
    const report = await engine.run();
    expect(report.overCap[0]).toMatchObject({ workflow: "WF10", agents: 11, limit: 10 });
    expect(report.violations.some((v) => v.kind === "WORKFLOW_OVER_CAP" && v.severity === "fail")).toBe(true);
  });

  it("enforces global 500 cap", async () => {
    const agents: RuntimeAgent[] = Array.from({ length: MAX_GLOBAL_AGENTS + 1 }, (_, i) => ({
      id: `A-${i}`,
      workflow: "WF",
    }));
    const engine = new WatchdogEngine(
      baseConfig(root, { runtime: { workflows: async () => [], agents: async () => agents } }),
    );
    const report = await engine.run();
    expect(report.violations.some((v) => v.kind === "GLOBAL_OVER_CAP")).toBe(true);
  });

  it("detects + flags underfilled workflows and dispatches refill (never merely reports)", async () => {
    await writeState(root, {
      "tasks.json": {
        schema_version: 1,
        items: [
          task("R-1", "READY"),
          task("R-2", "READY"),
          task("R-BLOCKED", "READY", ["T-NEVER"]),
        ],
      },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
    });
    const live: RuntimeWorkflow[] = [{ id: "WF10", agentIds: ["A-1"] }];
    const dispatched: string[] = [];
    const engine = new WatchdogEngine(
      baseConfig(root, {
        dispatch: true,
        runtime: { workflows: async () => live, agents: async () => [] },
        dispatchAdapter: {
          dispatch: async (req) => {
            dispatched.push(...req.taskIds);
            return { accepted: req.taskIds };
          },
        },
      }),
    );
    const report = await engine.run();
    // flag
    expect(report.underCapacity[0]).toMatchObject({ workflow: "WF10", slots: 9 });
    expect(report.underCapacity[0]!.taskIds).toContain("R-1");
    expect(report.underCapacity[0]!.taskIds).not.toContain("R-BLOCKED");
    // act
    expect(report.refilled[0]!.taskIds).toContain("R-1");
    expect(dispatched).toContain("R-1");
    expect(report.needsAttention).toBe(true);
  });

  it("pings stalled agents", async () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const agents: RuntimeAgent[] = [
      { id: "A-1", workflow: "WF1", taskId: "T-1", lastActivityAt: "2026-08-28T10:00:00Z" },
    ];
    const pings: string[] = [];
    const engine = new WatchdogEngine(
      baseConfig(root, {
        now: () => now,
        agentStaleMs: 30 * 60 * 1000,
        runtime: { workflows: async () => [], agents: async () => agents },
        pingAdapter: { ping: async (id) => { pings.push(id); } },
      }),
    );
    const report = await engine.run();
    expect(report.stalled.map((s) => s.agentId)).toEqual(["A-1"]);
    expect(pings).toEqual(["A-1"]);
  });

  it("kills duplicate task ownership (keeps newest)", async () => {
    const agents: RuntimeAgent[] = [
      { id: "A-1", taskId: "T-1", workflow: "W" },
      { id: "A-2", taskId: "T-1", workflow: "W" },
    ];
    const killed: string[] = [];
    const engine = new WatchdogEngine(
      baseConfig(root, {
        runtime: { workflows: async () => [], agents: async () => agents },
        killAdapter: { kill: async (id) => { killed.push(id); } },
      }),
    );
    const report = await engine.run();
    expect(report.duplicates).toHaveLength(1);
    expect(killed).toEqual(["A-2"]);
  });

  it("flags BUILDER_DONE without Sonnet QC PASS evidence", async () => {
    await writeState(root, {
      "tasks.json": { schema_version: 1, items: [task("T-1", "BUILDER_DONE")] },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
    });
    const engine = new WatchdogEngine(baseConfig(root));
    const report = await engine.run();
    expect(report.qcGaps.some((g) => g.taskId === "T-1")).toBe(true);
    expect(report.violations.some((v) => v.kind === "BUILDER_DONE_NO_QC")).toBe(true);
  });

  it("pushes PASS tasks to the merge queue", async () => {
    await writeState(root, {
      "tasks.json": {
        schema_version: 1,
        items: [
          task("T-PASS", "PASS"),
          task("T-ALREADY", "PASS"),
        ],
      },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": {
        schema_version: 1,
        items: [{ taskId: "T-ALREADY", branch: "task/x" }],
      },
    });
    const pushed: string[] = [];
    const engine = new WatchdogEngine(
      baseConfig(root, {
        mergeQueueAdapter: { push: async (id) => { pushed.push(id); return { accepted: true }; } },
      }),
    );
    const report = await engine.run();
    expect(report.queuePushes.map((q) => q.taskId)).toContain("T-PASS");
    expect(report.queuePushes.map((q) => q.taskId)).not.toContain("T-ALREADY");
    expect(pushed).toEqual(["T-PASS"]);
  });

  it("flags BLOCKED tasks without documented blockers", async () => {
    const now = new Date("2026-08-28T12:00:00Z");
    await writeState(root, {
      "tasks.json": { schema_version: 1, items: [task("T-1", "BLOCKED")] },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
      "task-updates/T-1.builder.json": {
        taskId: "T-1",
        phase: "BLOCKED",
        blockers: [],
      },
    });
    const engine = new WatchdogEngine(baseConfig(root, { now: () => now }));
    const report = await engine.run();
    expect(report.violations.some((v) => v.kind === "BLOCKED_INCOMPLETE")).toBe(true);
  });

  it("persists build-status.md (surgically) + ledger + atomic checkpoint when persist=true", async () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const stateDir = path.join(root, "state");
    await writeState(root, {
      "tasks.json": { schema_version: 1, items: [task("T-1", "MERGED")] },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
      "checkpoint.json": { schemaVersion: 1, lastWatchdogAt: null },
    });
    // Pre-existing status file with a section the watchog must NOT clobber.
    await writeFile(
      path.join(root, "build-status.md"),
      "# Build Status Dashboard (build-status.md)\n\n**Project:** mini-movie-creator-system (MMCS)\n**Updated:** 2026-08-28T00:00:00Z\n**Current Stage:** Batch Merge Landed\n\n---\n\n## 1. Task State Summary\n\n| Metric | Count |\n|---|---|\n| Total Tasks | 149 |\n| Merged Tasks | 35 |\n\n---\n\n## 2. Integration & Checkpoint State\n\n| Last Batch Merge Timestamp | 2026-08-28T14:38:00Z |\n",
    );
    const engine = new WatchdogEngine(
      baseConfig(root, { persist: true, now: () => now }),
    );
    const report = await engine.run();
    const status = await readFile(path.join(root, "build-status.md"), "utf8");
    expect(status).toContain("Watchdog cycle");
    expect(status).toContain("| Total Tasks | 1 |");
    // Section 2 owned by the batch merger preserved verbatim.
    expect(status).toContain("## 2. Integration & Checkpoint State");
    expect(status).toContain("| Last Batch Merge Timestamp | 2026-08-28T14:38:00Z |");
    const ledger = await readFile(path.join(root, "ledger.md"), "utf8");
    expect(ledger).toContain("WATCHDOG");
    const cp = JSON.parse(await readFile(path.join(stateDir, "checkpoint.json"), "utf8"));
    expect(cp.lastWatchdogAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("does not dispatch/persist in selftest mode", async () => {
    const live: RuntimeWorkflow[] = [{ id: "WF10", agentIds: ["A-1"] }];
    let dispatched = false;
    const engine = new WatchdogEngine(
      baseConfig(root, {
        selftest: true,
        persist: true,
        dispatch: true,
        runtime: { workflows: async () => live, agents: async () => [] },
        dispatchAdapter: {
          dispatch: async () => { dispatched = true; return { accepted: [] }; },
        },
      }),
    );
    const report = await engine.run();
    expect(report.lockAcquired).toBe(false);
    expect(dispatched).toBe(false);
    expect(report.underCapacity.length).toBeGreaterThan(0);
    expect(await readFile(path.join(root, "build-status.md"), "utf8").catch(() => "")).toBe("");
  });

  it("reconciles recorded branches against live worktrees", async () => {
    await writeState(root, {
      "tasks.json": {
        schema_version: 1,
        items: [
          { id: "T-1", status: "READY", branch: "task/T-1-here", worktree: "worktrees/T-1/" },
          { id: "T-2", status: "READY", branch: "task/T-2-missing", worktree: "worktrees/T-2/" },
        ],
      },
      "workflows.json": { schema_version: 1, items: [] },
      "agents.json": { schema_version: 1, items: [] },
      "merge-queue.json": { schema_version: 1, items: [] },
    });
    const git: GitAdapter = {
      ...noopGit,
      listWorktrees: async () => [
        { path: "worktrees/T-1/", branch: "task/T-1-here", sha: "abc" },
      ],
      listBranches: async () => ["task/T-1-here"],
    };
    const engine = new WatchdogEngine(baseConfig(root, { git }));
    const report = await engine.run();
    const missing = report.violations.filter((v) => v.kind === "WORKTREE_MISSING");
    expect(missing.map((v) => v.taskId)).toEqual(["T-2"]);
  });
});

// ---------------------------------------------------------------------------
// Real git adapter (proof: the same instrument we ship)
// ---------------------------------------------------------------------------

describe("RealGitAdapter against a fixture repo", () => {
  it("lists worktrees, branches, commit dates", async () => {
    const root = await fixtureRoot();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const git = new RealGitAdapter(root);
    // Unborn repo: every query is a control — rc-checked, never a throw.
    expect(await git.revParse("refs/heads/nope")).toBeNull();
    expect(await git.hasOrigin()).toBe(false);
    expect(await git.commitDate("HEAD")).toBeNull();
    expect(await git.listBranches()).toEqual([]);
  });

  it("reports real worktrees + branch names after init + commit", async () => {
    const root = await fixtureRoot();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        import("node:child_process").then(({ execFile }) =>
          execFile("git", args, { cwd: root }, (err, out) =>
            err ? reject(err) : resolve(out),
          ),
        );
      });
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "test@test"]);
    await run(["config", "user.name", "test"]);
    await run(["commit", "--allow-empty", "-q", "-m", "seed"]);
    const git = new RealGitAdapter(root);
    expect(await git.revParse("HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.listBranches()).toContain("main");
    expect(await git.commitDate("HEAD")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const wts = await git.listWorktrees();
    // git resolves the symlinked /tmp to the real path (e.g. /private/var),
    // so compare through realpath — the same path git reports.
    const real = await realpath(root);
    expect(
      wts.some((w) => w.path === real && w.branch === "refs/heads/main"),
    ).toBe(true);
  });
});
