/// <reference types="node" />
/**
 * CLI wrapper for the watchdog engine (task REC-008).
 *
 *   npx tsx scripts/orchestration/watchdog.cli.ts [--selftest] [--dry-run] [--root <dir>]
 *
 * `--selftest` is the acceptance mode: builds an artificially underfilled
 * workflow (1 live agent / 10 slots) with READY tasks whose dependencies are
 * satisfied, runs the full cycle, and asserts the report detects + flags the
 * undercapacity refill plan. Mutates nothing (no lock, no dispatch, no
 * ledger/checkpoint/build-status writes).
 *
 * `--dry-run` = full cycle computing the plan but no dispatch / no file writes
 * (lock + reads only).
 *
 * Real cycle: `npx tsx scripts/orchestration/watchdog.cli.ts`.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WatchdogEngine,
  RealGitAdapter,
  MAX_AGENTS_PER_WORKFLOW,
  type RuntimeWorkflow,
  type RuntimeAgent,
} from "./watchdog.js";

function parseArgs(argv: string[]): {
  selftest: boolean;
  dryRun: boolean;
  persist: boolean;
  repoRoot: string;
} {
  let selftest = false;
  let dryRun = false;
  let persist = true;
  let repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") selftest = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--no-persist") persist = false;
    else if (a === "--root") {
      i += 1;
      const v = argv[i];
      if (v) repoRoot = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: watchdog.cli.ts [--selftest] [--dry-run] [--no-persist] [--root <repoRoot>]",
      );
      process.exit(0);
    }
  }
  return { selftest, dryRun, persist, repoRoot };
}

async function main(): Promise<void> {
  const { selftest, dryRun, persist, repoRoot } = parseArgs(process.argv.slice(2));

  if (selftest) {
    const ok = await runSelftest();
    process.exit(ok ? 0 : 1);
  }

  const engine = new WatchdogEngine({
    repoRoot,
    selftest: false,
    dispatch: !dryRun,
    persist: persist && !dryRun,
    git: new RealGitAdapter(repoRoot),
  });
  const report = await engine.run();
  const summary = {
    cycleId: report.cycleId,
    lockAcquired: report.lockAcquired,
    lockError: report.lockError,
    recorded: report.recorded,
    actual: report.actual,
    overCap: report.overCap,
    underCapacity: report.underCapacity,
    refilled: report.refilled,
    stalled: report.stalled,
    qcGaps: report.qcGaps,
    queuePushes: report.queuePushes,
    violations: report.violations,
    needsAttention: report.needsAttention,
  };
  console.log(JSON.stringify(summary, null, 2));
}

/**
 * Acceptance selftest: an artificially underfilled workflow (1 of 10 agents
 * live, 3 READY tasks with satisfied deps) must be detected and its refill
 * plan flagged. Pure fixture state in a temp dir; no repo mutation.
 */
async function runSelftest(): Promise<boolean> {
  const root = await mkdtemp(path.join(tmpdir(), "watchdog-selftest-"));
  const stateDir = path.join(root, "state");
  const taskUpdates = path.join(stateDir, "task-updates");
  await mkdir(taskUpdates, { recursive: true });

  const now = new Date("2026-08-28T18:00:00Z");
  const tasks = {
    schema_version: 1,
    updated_at: now.toISOString(),
    items: [
      { id: "T-READY-1", status: "READY", dependsOn: [], workflow: "WF10" },
      { id: "T-READY-2", status: "READY", dependsOn: [], workflow: "WF10" },
      { id: "T-READY-3", status: "READY", dependsOn: [], workflow: "WF10" },
      { id: "T-BLOCKED-1", status: "READY", dependsOn: ["T-NEVER-1"], workflow: "WF10" },
    ],
  };
  const workflows = { schema_version: 1, items: [] };
  const agents = { schema_version: 1, items: [] };
  const queue = { schema_version: 1, items: [] };
  await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify(tasks, null, 2));
  await writeFile(path.join(stateDir, "workflows.json"), JSON.stringify(workflows, null, 2));
  await writeFile(path.join(stateDir, "agents.json"), JSON.stringify(agents, null, 2));
  await writeFile(path.join(stateDir, "merge-queue.json"), JSON.stringify(queue, null, 2));

  // Artificially underfilled: WF10 has 1 live agent of 10 slots.
  const liveWorkflows: RuntimeWorkflow[] = [{ id: "WF10", agentIds: ["A-1"] }];
  const liveAgents: RuntimeAgent[] = [
    { id: "A-1", workflow: "WF10", taskId: "T-BLOCKED-1", lastActivityAt: now.toISOString() },
  ];

  let detected = false;
  const engine = new WatchdogEngine({
    repoRoot: root,
    stateDir,
    selftest: true,
    persist: false,
    dispatch: false,
    now: () => now,
    git: {
      revParse: async () => null,
      listWorktrees: async () => [],
      listBranches: async () => [],
      commitDate: async () => null,
      hasOrigin: async () => false,
    },
    runtime: {
      workflows: async () => liveWorkflows,
      agents: async () => liveAgents,
    },
    dispatchAdapter: {
      dispatch: async () => {
        detected = true;
        return { accepted: [] };
      },
    },
  });
  const report = await engine.run();

  // Assertions: underfilled detected + refill flagged with ready tasks.
  const underfilled = report.underCapacity.some(
    (e) =>
      e.workflow === "WF10" &&
      e.slots === MAX_AGENTS_PER_WORKFLOW - 1 &&
      e.taskIds.includes("T-READY-1") &&
      e.taskIds.includes("T-READY-2") &&
      e.taskIds.includes("T-READY-3") &&
      !e.taskIds.includes("T-BLOCKED-1"),
  );
  const lockNotTaken = !report.lockAcquired;
  const ok =
    underfilled && lockNotTaken && report.actual.workflows === 1 && !detected;
  console.log(
    JSON.stringify(
      {
        selftest: true,
        ok,
        underfilledPlan: report.underCapacity,
        refillFlagged: underfilled,
        lockAcquired: report.lockAcquired,
        dispatchRan: detected,
      },
      null,
      2,
    ),
  );
  return ok;
}

main().catch((err) => {
  console.error(String((err as Error).message ?? err));
  process.exitCode = 1;
});
