/// <reference types="node" />
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CheckpointService,
  toResumeView,
  uniqueIds,
  type CheckpointState,
  type ResumeView,
} from "../../packages/core/src/recovery/index.js";
import {
  KieTaskRunner,
  type KieCreateTaskRequest,
  type KieTaskClient,
  type KieTaskInfo,
  type KieTaskRecord,
  type KieTaskStore,
} from "../../packages/providers/src/kie/task/index.js";

/**
 * REC-010 — restart simulation (spec §32 Recovery acceptance, todo TASK-REC-010).
 *
 * Three scenarios, all against REAL subsystem code (no re-implementations):
 *
 *   1. Active task map recovery — CORE-014 CheckpointService writes a durable
 *      checkpoint; a fresh "restarted" service instance reloads it and
 *      toResumeView() reconstructs the ready/active/qc/blocked/mergeQueue
 *      task-id buckets exactly. Re-running the recovery promote-step with the
 *      same inputs must NOT duplicate task ids (set semantics — the runbook §6
 *      SessionStart rule "do not duplicate ACTIVE/PASS/MERGED tasks").
 *   2. Worktree/branch reconciliation — the recorded worktree/branch list is
 *      compared against live `git worktree list` / `git branch --list` output;
 *      a deviation (extra or missing) is reported as a reconciliation mismatch,
 *      and matching state passes.
 *   3. Kill provider polling after submission — KIE-002 KieTaskRunner persists
 *      the provider task ID before any poll; polling is "killed" (never started
 *      for the record), the process state survives on disk, and a resumed
 *      runner polls the EXISTING providerTaskId with createTask never called
 *      again (no resubmit — spec §18/§32).
 *
 * `runScenario` returns per-scenario pass/fail with evidence; `simulateRestart`
 * runs all three and returns an aggregate; the CLI entry exits 0 only when
 * every scenario passed (acceptance: "simulation script exits 0").
 */

export interface ScenarioStep {
  /** Human-readable step name, e.g. "pre-restart checkpoint save". */
  name: string;
  ok: boolean;
  /** Load-bearing evidence (counts/ids observed), kept terse. */
  evidence: string;
}

export interface ScenarioResult {
  scenario: string;
  ok: boolean;
  steps: ScenarioStep[];
}

export interface RestartSimResult {
  ok: boolean;
  scenarios: ScenarioResult[];
  /** Where the sandboxed state lived (temp dir), for log inspection. */
  scratchRoot: string;
}

// ---------------------------------------------------------------------------
// Scenario 1 — active task map recovery without duplicate task creation
// ---------------------------------------------------------------------------

export interface TaskMapSeed {
  ready: string[];
  active: string[];
  qc: string[];
  blocked: string[];
  mergeQueue: string[];
}

function emptyTaskMapSeed(): TaskMapSeed {
  return { ready: [], active: [], qc: [], blocked: [], mergeQueue: [] };
}

/**
 * The recovery promote-step the SessionStart path performs (runbook §6):
 * load the recorded checkpoint, then re-record every observed task into its
 * bucket. Idempotent by contract: running it again on an already-recovered
 * map must not grow any bucket (no duplicate task creation).
 */
export async function recoverTaskMap(
  repoRoot: string,
  seed: TaskMapSeed,
): Promise<{ view: ResumeView; state: CheckpointState }> {
  const service = new CheckpointService(repoRoot);
  await service.update((state) => {
    // Set-union via CORE-014's uniqueIds: re-recording an already-recovered
    // id must be a no-op (runbook §6 "do not duplicate ACTIVE/PASS/MERGED").
    state.readyTaskIds = uniqueIds([...state.readyTaskIds, ...seed.ready]);
    state.activeTaskIds = uniqueIds([...state.activeTaskIds, ...seed.active]);
    state.qcTaskIds = uniqueIds([...state.qcTaskIds, ...seed.qc]);
    state.blockedTaskIds = uniqueIds([...state.blockedTaskIds, ...seed.blocked]);
    state.mergeQueueTaskIds = uniqueIds([...state.mergeQueueTaskIds, ...seed.mergeQueue]);
  });
  const state = await service.load();
  return { view: toResumeView(state), state };
}

/**
 * What a restarted session re-runs: the SAME recovery promote-step against the
 * checkpoint that already holds the recovered map. Duplicate-free is proven by
 * bucket size + membership equality across the two recoveries.
 */
export async function simulateTaskMapRecovery(
  scratchRoot: string,
  seed: TaskMapSeed = {
    ready: ["REC-011", "REL-001"],
    active: ["DIR-010", "VID-012"],
    qc: ["CAP-001"],
    blocked: ["GHL-004"],
    mergeQueue: ["KIE-002"],
  },
): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const repoRoot = await mkdtemp(join(scratchRoot, "taskmap-"));
  try {
    const first = await recoverTaskMap(repoRoot, seed);
    steps.push({
      name: "pre-restart checkpoint save",
      ok:
        first.state.activeTaskIds.length === seed.active.length &&
        first.state.readyTaskIds.length === seed.ready.length &&
        first.state.qcTaskIds.length === seed.qc.length &&
        first.state.blockedTaskIds.length === seed.blocked.length &&
        first.state.mergeQueueTaskIds.length === seed.mergeQueue.length,
      evidence: `buckets ready=${first.state.readyTaskIds.length} active=${first.state.activeTaskIds.length} qc=${first.state.qcTaskIds.length} blocked=${first.state.blockedTaskIds.length} mergeQueue=${first.state.mergeQueueTaskIds.length}`,
    });

    // ---- the "restart": brand-new service instance, disk is the only memory
    const restarted = new CheckpointService(repoRoot);
    const reloaded = await restarted.load();
    const view = toResumeView(reloaded);
    const mapMatches =
      view.active.size === seed.active.length &&
      seed.active.every((id) => view.active.has(id)) &&
      view.ready.size === seed.ready.length &&
      seed.ready.every((id) => view.ready.has(id)) &&
      view.qc.size === seed.qc.length &&
      seed.qc.every((id) => view.qc.has(id)) &&
      view.blocked.size === seed.blocked.length &&
      seed.blocked.every((id) => view.blocked.has(id)) &&
      view.mergeQueue.size === seed.mergeQueue.length &&
      seed.mergeQueue.every((id) => view.mergeQueue.has(id));
    steps.push({
      name: "restarted session reloads recorded task map",
      ok: mapMatches,
      evidence: `reloaded buckets: ready=${view.ready.size} active=${view.active.size} qc=${view.qc.size} blocked=${view.blocked.size} mergeQueue=${view.mergeQueue.size}`,
    });

    // ---- re-run the recovery step; buckets must not grow (no dupes)
    const second = await recoverTaskMap(repoRoot, seed);
    const noDuplicates =
      second.state.activeTaskIds.length === seed.active.length &&
      second.state.readyTaskIds.length === seed.ready.length &&
      second.state.qcTaskIds.length === seed.qc.length &&
      second.state.blockedTaskIds.length === seed.blocked.length &&
      second.state.mergeQueueTaskIds.length === seed.mergeQueue.length;
    steps.push({
      name: "re-recovery creates no duplicate task ids",
      ok: noDuplicates,
      evidence: `after re-recovery: ready=${second.state.readyTaskIds.length} active=${second.state.activeTaskIds.length} qc=${second.state.qcTaskIds.length} blocked=${second.state.blockedTaskIds.length} mergeQueue=${second.state.mergeQueueTaskIds.length}`,
    });

    const duplicates: string[] = [];
    for (const bucket of [
      second.state.readyTaskIds,
      second.state.activeTaskIds,
      second.state.qcTaskIds,
      second.state.blockedTaskIds,
      second.state.mergeQueueTaskIds,
    ]) {
      const seen = new Set<string>();
      for (const id of bucket) {
        if (seen.has(id)) duplicates.push(id);
        seen.add(id);
      }
    }
    steps.push({
      name: "no duplicate ids inside any bucket",
      ok: duplicates.length === 0,
      evidence: duplicates.length === 0 ? "all buckets duplicate-free" : `dupes: ${duplicates.join(",")}`,
    });

    return { scenario: "active-task-map-recovery", ok: steps.every((s) => s.ok), steps };
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — worktree/branch reconciliation matches recorded state
// ---------------------------------------------------------------------------

/** A recorded (checkpoint-side) worktree/branch entry. */
export interface RecordedWorktree {
  /** e.g. "worktrees/REC-010" (repo-relative) or an absolute path. */
  path: string;
  /** e.g. "task/REC-010-restart-sim". */
  branch: string;
}

export interface WorktreeReconciliation {
  /** Recorded entries missing from the live checkout. */
  missing: RecordedWorktree[];
  /** Live entries not present in the recording (excluding the main checkout). */
  unexpected: { path: string; branch: string }[];
  ok: boolean;
}

/** Evidence captured from the kill-polling scenario (diagnostics/logging). */
export interface KillPollEvidence {
  createCountAfterKill: number;
  pollCountAfterKill: number;
  pollRefsAfterKill: string[];
  resumedRecord: KieTaskRecord | null;
  terminalState: KieTaskRecord | null;
}

function normalizeWorktreePath(repoRoot: string, p: string): string {
  return resolve(repoRoot, p).replace(/\/+$/, "");
}

export async function reconcileWorktrees(
  repoRoot: string,
  recorded: RecordedWorktree[],
): Promise<WorktreeReconciliation> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });
  const live: { path: string; branch: string | null }[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "") {
      if (current.path) live.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) live.push({ path: current.path, branch: current.branch ?? null });

  const liveByPath = new Map(live.map((w) => [normalizeWorktreePath(repoRoot, w.path), w]));
  const missing: RecordedWorktree[] = [];
  for (const rec of recorded) {
    const found = liveByPath.get(normalizeWorktreePath(repoRoot, rec.path));
    if (!found || found.branch !== rec.branch) {
      missing.push(rec);
    }
  }
  const recordedResolved = new Set(recorded.map((r) => normalizeWorktreePath(repoRoot, r.path)));
  const unexpected = live
    .filter((w) => !recordedResolved.has(normalizeWorktreePath(repoRoot, w.path)))
    // The main checkout (no task branch) is never "unexpected".
    .filter((w) => w.branch !== null && w.branch !== "")
    .map((w) => ({ path: w.path, branch: w.branch as string }));
  const ok = missing.length === 0 && unexpected.length === 0;
  return { missing, unexpected, ok };
}

export async function simulateWorktreeReconciliation(
  repoRoot: string,
): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);

  // Build the recorded state from the LIVE repo first, then verify the
  // reconciler agrees with reality (positive control), then verify a
  // deliberately wrong record is flagged (discriminating power).
  const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const live: RecordedWorktree[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    else if (line === "") {
      if (current.path && current.branch) live.push({ path: current.path, branch: current.branch });
      current = {};
    }
  }
  if (current.path && current.branch) live.push({ path: current.path, branch: current.branch });

  const truthy = await reconcileWorktrees(repoRoot, live);
  steps.push({
    name: "recorded==live reconciliation passes",
    ok: truthy.ok,
    evidence: `compared ${live.length} recorded worktrees against live git state`,
  });

  const falsy = await reconcileWorktrees(repoRoot, [
    ...live,
    { path: join(repoRoot, "worktrees/REC-999-phantom"), branch: "task/REC-999-phantom-branch" },
  ]);
  steps.push({
    name: "phantom recorded worktree is detected",
    ok: !falsy.ok && falsy.missing.length === 1,
    evidence: `missing=${falsy.missing.length} unexpected=${falsy.unexpected.length}`,
  });

  const drifted = await reconcileWorktrees(
    repoRoot,
    live.map((w, i) => (i === 0 ? { ...w, branch: `${w.branch}-drifted` } : w)),
  );
  steps.push({
    name: "branch drift on a recorded worktree is detected",
    ok: !drifted.ok && drifted.missing.length === 1,
    evidence: `missing=${drifted.missing.length} unexpected=${drifted.unexpected.length}`,
  });

  return { scenario: "worktree-branch-reconciliation", ok: steps.every((s) => s.ok), steps };
}

// ---------------------------------------------------------------------------
// Scenario 3 — kill provider polling after submission → resume polls existing task ID
// ---------------------------------------------------------------------------

/**
 * Scripted Kie client that counts calls and records every polled task id.
 * Mirrors the test double in packages/providers/src/kie/task/task.test.ts.
 */
export function scriptedKieClient(
  taskId: string,
  infos: KieTaskInfo[],
  calls: { createCount: number; pollRefs: string[] } = { createCount: 0, pollRefs: [] },
): KieTaskClient {
  let pollIndex = 0;
  return {
    async createTask() {
      calls.createCount += 1;
      return { taskId };
    },
    async getTask(id) {
      calls.pollRefs.push(id);
      const info = infos[Math.min(pollIndex, infos.length - 1)];
      pollIndex += 1;
      if (!info) throw new Error(`no scripted info for ${id}`);
      return info;
    },
  };
}

/**
 * File-backed KieTaskStore (JSON per ref in `dir`) so the "process kill"
 * boundary is real: the pre-kill runner and the post-kill runner share state
 * only through disk, exactly like a real restart.
 */
export class FileKieStore implements KieTaskStore {
  readonly dir: string;
  private rows = new Map<string, KieTaskRecord>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(ref: string): Promise<KieTaskRecord | undefined> {
    const raw = await readFile(join(this.dir, `${encodeURIComponent(ref)}.json`), "utf8").catch(
      () => null,
    );
    if (raw === null) return this.rows.get(ref);
    return JSON.parse(raw) as KieTaskRecord;
  }

  async save(record: KieTaskRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${encodeURIComponent(record.ref)}.json`), JSON.stringify(record, null, 2));
    this.rows.set(record.ref, { ...record });
  }
}

/**
 * Scenario 3 in three phases, with the "kill" between phase 2 and 3:
 *   phase A (submit): ensureSubmitted → SUBMITTED with providerTaskId persisted.
 *   phase B (kill): the poller never runs for this record — simulate a crash
 *     right after submission. Evidence: createTask called exactly once.
 *   phase C (resume): a NEW runner + NEW file store over the SAME dir loads
 *     the record and polls the EXISTING providerTaskId to terminal. Evidence:
 *     createTask count STILL 1 (no resubmit), polls hit the persisted id.
 */
export async function simulateKillPollingResume(
  scratchRoot: string,
  taskId = "kie-sim-task-001",
): Promise<{ result: ScenarioResult; evidence: KillPollEvidence }> {
  const steps: ScenarioStep[] = [];
  const calls = { createCount: 0, pollRefs: [] as string[] };
  const infos: KieTaskInfo[] = [
    { taskId, state: "waiting" },
    { taskId, state: "generating" },
    { taskId, state: "success", result: { resultUrls: ["https://cdn.example.com/S01E01_SH01.mp4"] } },
  ];
  const REQUEST: KieCreateTaskRequest = {
    model: "bytedance/seedance-v1-pro-text-to-video",
    input: { prompt: "sim prompt", aspect_ratio: "9:16" },
  };

  const storeDir = join(await mkdtemp(join(scratchRoot, "kie-")), "jobs");
  try {
    // ---- phase A: submit
    const storeA = new FileKieStore(storeDir);
    const runnerA = new KieTaskRunner(scriptedKieClient(taskId, infos, calls), storeA, {
      now: () => new Date(1_700_000_000_000).toISOString(),
    });
    const submitted = await runnerA.ensureSubmitted("shot-01:keyframe", REQUEST);
    steps.push({
      name: "submission persisted providerTaskId before any poll",
      ok: submitted.state === "SUBMITTED" && submitted.providerTaskId === taskId,
      evidence: `state=${submitted.state} providerTaskId=${submitted.providerTaskId}`,
    });

    // ---- phase B: kill the poller (crash after submission, before first poll)
    const createCountAfterKill = calls.createCount;
    steps.push({
      name: "polling killed after submission (createTask called exactly once)",
      ok: createCountAfterKill === 1 && calls.pollRefs.length === 0,
      evidence: `createCount=${createCountAfterKill} polls=${calls.pollRefs.length}`,
    });

    // ---- phase C: resume with fresh runner + fresh store over the same dir
    const storeC = new FileKieStore(storeDir);
    const runnerC = new KieTaskRunner(scriptedKieClient(taskId, infos, calls), storeC, {
      now: () => new Date(1_700_000_005_000).toISOString(),
      sleep: async () => undefined,
    });
    const resumedLoad = await storeC.load("shot-01:keyframe");
    const resumed = await runnerC.ensureSubmitted("shot-01:keyframe", REQUEST);
    // Resume = poll the persisted id. ensureSubmitted must return the existing
    // record untouched (SUBMITTED, same id); the actual poll is pollOnce.
    const resumedOk =
      calls.createCount === 1 &&
      resumed.providerTaskId === taskId &&
      resumed.state === "SUBMITTED" &&
      resumedLoad?.providerTaskId === taskId;
    const polled = await runnerC.pollOnce("shot-01:keyframe");
    const pollOk =
      calls.createCount === 1 &&
      calls.pollRefs.length > 0 &&
      calls.pollRefs.every((id) => id === taskId) &&
      polled.providerTaskId === taskId;
    steps.push({
      name: "resume polls existing task ID, never resubmits",
      ok: resumedOk && pollOk,
      evidence: `createCount=${calls.createCount} pollRefs=[${calls.pollRefs.join(",")}] polledState=${polled.state}`,
    });

    const terminal = await runnerC.runToTerminal("shot-01:keyframe", REQUEST, {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    steps.push({
      name: "resumed poll reaches GENERATED_TEMPORARY",
      ok: terminal.state === "GENERATED_TEMPORARY" && calls.createCount === 1,
      evidence: `state=${terminal.state} resultUrls=${terminal.resultUrls?.length ?? 0} createCount=${calls.createCount}`,
    });

    const evidence: KillPollEvidence = {
      createCountAfterKill,
      pollCountAfterKill: calls.pollRefs.length,
      pollRefsAfterKill: [...calls.pollRefs],
      resumedRecord: resumed,
      terminalState: terminal,
    };
    return { result: { scenario: "kill-polling-resume", ok: steps.every((s) => s.ok), steps }, evidence };
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Aggregate runner + CLI entry
// ---------------------------------------------------------------------------

export interface SimulateRestartOptions {
  /** Repo whose git state scenario 2 reconciles against. Defaults to the repo containing this script. */
  repoRoot?: string;
  /** Where sandboxed state lives; a fresh temp dir when omitted. */
  scratchRoot?: string;
}

export async function simulateRestart(
  opts: SimulateRestartOptions = {},
): Promise<RestartSimResult> {
  const scratchRoot =
    opts.scratchRoot ?? (await mkdtemp(join(tmpdir(), "mmcs-restart-sim-")));
  const repoRoot =
    opts.repoRoot ?? resolve(join(fileURLToPath(import.meta.url), "..", "..", ".."));

  const scenarios: ScenarioResult[] = [];
  let taskMapError: string | null = null;
  let reconcileError: string | null = null;
  let killPollError: string | null = null;

  try {
    scenarios.push(await simulateTaskMapRecovery(scratchRoot));
  } catch (err) {
    taskMapError = err instanceof Error ? err.message : String(err);
    scenarios.push({
      scenario: "active-task-map-recovery",
      ok: false,
      steps: [{ name: "scenario crashed", ok: false, evidence: taskMapError }],
    });
  }
  try {
    scenarios.push(await simulateWorktreeReconciliation(repoRoot));
  } catch (err) {
    reconcileError = err instanceof Error ? err.message : String(err);
    scenarios.push({
      scenario: "worktree-branch-reconciliation",
      ok: false,
      steps: [{ name: "scenario threw", ok: false, evidence: reconcileError }],
    });
  }
  try {
    const { result } = await simulateKillPollingResume(scratchRoot);
    scenarios.push(result);
  } catch (err) {
    killPollError = err instanceof Error ? err.message : String(err);
    scenarios.push({
      scenario: "kill-polling-resume",
      ok: false,
      steps: [{ name: "scenario threw", ok: false, evidence: killPollError }],
    });
  }

  const ok = scenarios.every((s) => s.ok);
  return { ok, scenarios, scratchRoot };
}

export function formatReport(result: RestartSimResult): string {
  const lines: string[] = [];
  lines.push("=== MMCS restart simulation (REC-010) ===");
  for (const scenario of result.scenarios) {
    lines.push(`[${scenario.ok ? "PASS" : "FAIL"}] ${scenario.scenario}`);
    for (const step of scenario.steps) {
      lines.push(`  ${step.ok ? "ok" : "FAIL"} - ${step.name} :: ${step.evidence}`);
    }
  }
  lines.push(`result: ${result.ok ? "PASS" : "FAIL"} (scratch: ${result.scratchRoot})`);
  return lines.join("\n");
}

/** CLI entry: exits 0 when every scenario passed, 1 otherwise. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const repoRootIdx = argv.indexOf("--repo-root");
  const repoRoot =
    repoRootIdx >= 0 && argv[repoRootIdx + 1] ? resolve(argv[repoRootIdx + 1]!) : undefined;
  const result = await simulateRestart({ repoRoot });
  process.stdout.write(`${formatReport(result)}\n`);
  return result.ok ? 0 : 1;
}

// Executed directly (`npx tsx scripts/orchestration/restart-sim.ts`): run and exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`restart-sim failed: ${err instanceof Error ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}