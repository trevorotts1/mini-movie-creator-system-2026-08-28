/// <reference types="node" />
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileKieStore,
  recoverTaskMap,
  reconcileWorktrees,
  simulateKillPollingResume,
  simulateTaskMapRecovery,
  simulateWorktreeReconciliation,
  scriptedKieClient,
  formatReport,
  main,
  simulateRestart,
  type KillPollEvidence,
  type RecordedWorktree,
  type RestartSimResult,
} from "./restart-sim.js";
import { CHECKPOINT_FILE, CHECKPOINT_SCHEMA_VERSION } from "../../packages/core/src/recovery/index.js";
import type { KieTaskInfo } from "../../packages/providers/src/kie/task/index.js";

let scratchRoot: string;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "mmcs-restart-sim-test-"));
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

const DEFAULT_SEED = {
  ready: ["REC-011", "REL-001"],
  active: ["DIR-010", "VID-012"],
  qc: ["CAP-001"],
  blocked: ["GHL-004"],
  mergeQueue: ["KIE-002"],
};

describe("scenario 1 — active task map recovery (spec §32 recovery)", () => {
  it("recovers the full task map after restart and never duplicates ids", async () => {
    const result = await simulateTaskMapRecovery(scratchRoot, DEFAULT_SEED);
    expect(result.ok).toBe(true);
    const names = result.steps.map((s) => s.name);
    expect(names).toContain("pre-restart checkpoint save");
    expect(names).toContain("restarted session reloads recorded task map");
    expect(names).toContain("re-recovery creates no duplicate task ids");
    expect(names).toContain("no duplicate ids inside any bucket");
    for (const step of result.steps) {
      expect(step.ok, `${step.name}: ${step.evidence}`).toBe(true);
    }
  });

  it("re-recording an already-recovered map is a set no-op (duplicate guard)", async () => {
    const repoRoot = await mkdtemp(join(scratchRoot, "dupes-"));
    const first = await recoverTaskMap(repoRoot, DEFAULT_SEED);
    const second = await recoverTaskMap(repoRoot, DEFAULT_SEED);
    expect(second.state.activeTaskIds).toEqual(first.state.activeTaskIds);
    expect(second.state.readyTaskIds).toEqual(first.state.readyTaskIds);
    expect(second.state.qcTaskIds).toEqual(first.state.qcTaskIds);
    expect(second.state.blockedTaskIds).toEqual(first.state.blockedTaskIds);
    expect(second.state.mergeQueueTaskIds).toEqual(first.state.mergeQueueTaskIds);
    expect(second.state.activeTaskIds).toHaveLength(DEFAULT_SEED.active.length);
  });

  it("a restarted CheckpointService reads the exact buckets from disk", async () => {
    const repoRoot = await mkdtemp(join(scratchRoot, "reload-"));
    await recoverTaskMap(repoRoot, DEFAULT_SEED);
    // Simulate reading the raw document like a recovery path would.
    const raw = JSON.parse(
      await readFile(join(repoRoot, "state", CHECKPOINT_FILE), "utf8"),
    ) as { schemaVersion: number; activeTaskIds: string[] };
    expect(raw.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(raw.activeTaskIds.sort()).toEqual([...DEFAULT_SEED.active].sort());
  });
});

describe("scenario 2 — worktree/branch reconciliation", () => {
  /** Run git in the repo this test lives in (integration branch is the sim target). */
  async function liveRecorded(): Promise<{ repoRoot: string; recorded: RecordedWorktree[] }> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    // Repo root = three levels up from this file (scripts/orchestration/).
    const repoRoot = join(__dirname, "..", "..");
    const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
    const recorded: RecordedWorktree[] = [];
    let current: { path?: string; branch?: string } = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
      else if (line.startsWith("branch "))
        current.branch = line.slice("branch ".length).replace("refs/heads/", "");
      else if (line === "") {
        if (current.path && current.branch) recorded.push({ path: current.path!, branch: current.branch! });
        current = {};
      }
    }
    if (current.path && current.branch) recorded.push({ path: current.path, branch: current.branch });
    return { repoRoot, recorded };
  }

  it("matches recorded state against live git worktrees (positive control)", async () => {
    const { repoRoot, recorded } = await liveRecorded();
    expect(recorded.length).toBeGreaterThan(0);
    const reconciliation = await reconcileWorktrees(repoRoot, recorded);
    expect(reconciliation.ok, JSON.stringify(reconciliation.missing.slice(0, 3))).toBe(true);
    expect(reconciliation.unexpected).toHaveLength(0);
  });

  it("flags a phantom recorded worktree and branch drift (discriminating power)", async () => {
    const { repoRoot, recorded } = await liveRecorded();
    const phantom = await reconcileWorktrees(repoRoot, [
      ...recorded,
      { path: join(repoRoot, "worktrees/PHANTOM"), branch: "task/PHANTOM-branch" },
    ]);
    expect(phantom.ok).toBe(false);
    expect(phantom.missing).toHaveLength(1);
    expect(phantom.missing[0]!.branch).toBe("task/PHANTOM-branch");

    const drifted = await reconcileWorktrees(
      repoRoot,
      recorded.map((w, i) => (i === 0 ? { ...w, branch: `${w.branch}-drift` } : w)),
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.missing).toHaveLength(1);
    expect(drifted.missing[0]!.branch.endsWith("-drift")).toBe(true);
  });

  it("treats the main checkout (branchless worktree) as never-unexpected", async () => {
    const { repoRoot, recorded } = await liveRecorded();
    // Dropping all recorded entries should make every branched worktree unexpected,
    // but a branchless main checkout must not appear in `unexpected`.
    const reconciliation = await reconcileWorktrees(repoRoot, recorded.slice(0, 0));
    for (const extra of reconciliation.unexpected) {
      expect(extra.branch).not.toBe("");
      expect(extra.branch).not.toBeNull();
    }
  });

  it("reconciles with relative recorded paths correctly", async () => {
    const { repoRoot, recorded } = await liveRecorded();
    // Convert absolute paths to repo-relative paths
    const relativeRecorded = recorded.map((w) => ({
      ...w,
      path: w.path.startsWith(repoRoot) ? w.path.slice(repoRoot.length).replace(/^\/+/, "") : w.path,
    }));
    const reconciliation = await reconcileWorktrees(repoRoot, relativeRecorded);
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.missing).toHaveLength(0);
    expect(reconciliation.unexpected).toHaveLength(0);
  });

  it("full scenario passes against the real repo", async () => {
    const { repoRoot } = await liveRecorded();
    const result = await simulateWorktreeReconciliation(repoRoot);
    expect(result.ok).toBe(true);
  });
});

describe("scenario 3 — kill provider polling after submission (spec §18/§32)", () => {
  it("resume polls the existing provider task ID and never resubmits", async () => {
    const { result, evidence } = await simulateKillPollingResume(scratchRoot);
    expect(result.ok).toBe(true);
    expect(evidence.createCountAfterKill).toBe(1);
    expect(evidence.pollRefsAfterKill.length).toBeGreaterThan(0);
    for (const id of evidence.pollRefsAfterKill) expect(id).toBe("kie-sim-task-001");
    expect(evidence.terminalState?.state).toBe("GENERATED_TEMPORARY");
  });

  it("FileKieStore round-trips records across a simulated process death", async () => {
    const dir = join(await mkdtemp(join(scratchRoot, "store-")), "jobs");
    const writer = new FileKieStore(dir);
    await writer.save({
      ref: "shot-01:keyframe",
      state: "SUBMITTED",
      providerTaskId: "persisted-id-123",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    // "Restart": brand-new store instance over the same dir, empty memory.
    const reader = new FileKieStore(dir);
    const loaded = await reader.load("shot-01:keyframe");
    expect(loaded?.providerTaskId).toBe("persisted-id-123");
    expect(loaded?.state).toBe("SUBMITTED");
  });

  it("a record with no providerTaskId refuses to poll (would-resubmit guard)", async () => {
    const dir = join(await mkdtemp(join(scratchRoot, "guard-")), "jobs");
    const store = new FileKieStore(dir);
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const infos: KieTaskInfo[] = [{ taskId: "x", state: "success", result: { resultUrls: ["https://x/y.mp4"] } }];
    const { KieTaskRunner } = await import("../../packages/providers/src/kie/task/index.js");
    const runner = new KieTaskRunner(scriptedKieClient("t", infos, calls), store);
    await expect(runner.pollOnce("never-submitted")).rejects.toThrow(/no persisted record|providerTaskId/);
    expect(calls.createCount).toBe(0);
  });
});

describe("aggregate runner + CLI", () => {
  it("simulateRestart runs all three scenarios green", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const repoRoot = join(__dirname, "..", "..");
    const result: RestartSimResult = await simulateRestart({ repoRoot, scratchRoot });
    expect(result.scenarios).toHaveLength(3);
    expect(result.ok).toBe(true);
    const report = formatReport(result);
    expect(report).toContain("[PASS] active-task-map-recovery");
    expect(report).toContain("[PASS] worktree-branch-reconciliation");
    expect(report).toContain("[PASS] kill-polling-resume");
    expect(report).toContain("result: PASS");
    // Keep git usage honest for scenario 2 inside the aggregate run.
    await execFileP("git", ["status", "--short", "--branch"], { cwd: repoRoot });
  }, 60_000);

  it("CLI main() exits 0 on success", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const repoRoot = join(__dirname, "..", "..");
    const code = await main(["--repo-root", repoRoot]);
    expect(code).toBe(0);
    // and git is actually usable from the resolved root (control for scenario 2)
    await execFileP("git", ["rev-parse", "--git-dir"], { cwd: repoRoot });
  }, 60_000);

  it("report writer is non-empty and machine-parsable", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const repoRoot = join(__dirname, "..", "..");
    const result = await simulateRestart({ repoRoot, scratchRoot });
    const report = formatReport(result);
    expect(report.split("\n")[0]).toContain("restart simulation");
    expect(report).toMatch(/result: (PASS|FAIL)/);
  }, 60_000);
});