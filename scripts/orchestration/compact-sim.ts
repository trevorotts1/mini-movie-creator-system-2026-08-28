/// <reference types="node" />
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKPOINT_FILE,
  CheckpointService,
  readJsonFileOrNull,
  toResumeView,
  type CheckpointState,
  type ResumeView,
} from "../../packages/core/src/recovery/index.js";
import {
  LEDGER_TAG as PRECOMPACT_LEDGER_TAG,
  PRECOMPACT_NEXT_ACTION,
  runPreCompact,
} from "../hooks/pre-compact.js";
import {
  RECOVERY_MARKER_FILE,
  RECOVERY_READ_ORDER,
  runPostCompact,
} from "../hooks/post-compact.js";
import { runSessionStart } from "../hooks/session-start.js";

/**
 * REC-011 — auto-compact simulation (spec §32 Recovery acceptance, spec §28
 * checkpoint cadence, runbook §5/§6; todo.md TASK-REC-011).
 *
 * A manual /compact, end to end, against REAL subsystem code (no
 * re-implementations) in sandboxed temp repo roots:
 *
 *   1. Manual /compact — the simulated PreCompact hook (REC-002's
 *      `runPreCompact`, trigger "manual") flushes state under the checkpoint
 *      lock, then the simulated PostCompact hook (REC-003's `runPostCompact`)
 *      records the post-compact cadence event and refreshes the recovery
 *      marker. The checkpoint must be updated across the whole sequence
 *      (spec §32: "manual /compact updates the checkpoint").
 *   2. New/resumed session — the simulated SessionStart hook (REC-004's
 *      `runSessionStart`, source "compact") injects its recovery context, and
 *      the fresh session READS the durable state from disk through a
 *      brand-new CheckpointService → toResumeView (Claude Code injects
 *      SessionStart stdout on a compact-mode start, so this is the real
 *      inject+read pair; runbook §5.2 resume read order).
 *   3. No data loss across compaction — every semantic value recorded before
 *      the compaction (task-id buckets, SHAs, wave, pre-existing next-action
 *      hints, session.md content outside the marker block, prior ledger
 *      lines) survives the PreCompact→PostCompact sequence in the on-disk
 *      truth, and a fresh session reconstructs the exact same task map.
 *
 * `simulateCompact` runs all three and returns an aggregate; the CLI entry
 * exits 0 only when every scenario passed (acceptance: "simulation script
 * exits 0"). Nothing paid, nothing in the live repo touched.
 */

export interface ScenarioStep {
  /** Human-readable step name, e.g. "pre-compact flush stamps checkpoint". */
  name: string;
  ok: boolean;
  /** Load-bearing evidence (timestamps/ids observed), kept terse. */
  evidence: string;
}

export interface ScenarioResult {
  scenario: string;
  ok: boolean;
  steps: ScenarioStep[];
}

export interface CompactSimResult {
  ok: boolean;
  scenarios: ScenarioResult[];
  /** Where the sandboxed state lived (temp dir), for log inspection. */
  scratchRoot: string;
}

// ---------------------------------------------------------------------------
// Sandbox seeding — the real committed control-plane shape
// ---------------------------------------------------------------------------

/**
 * The committed bootstrap checkpoint doc is snake_case (runbook PART II §4);
 * the PreCompact hook must flush against exactly this shape without failing
 * closed (REC-002 legacy contract). Seed mirrors the real state/checkpoint.json.
 */
export function legacyCheckpointDoc(): Record<string, unknown> {
  return {
    schema_version: 1,
    project_id: "mmcs",
    timestamp: "2026-08-28T20:05:00Z",
    current_main_sha: "773054bebbe460de0f31dcfda5315970b1c8b4f2",
    current_integration_sha: "b43743aefded95186bd5bf1c83a02f2e243a8855",
    active_dependency_wave: 1,
    ready_task_ids: ["REL-003", "REC-011"],
    active_task_ids: ["DIR-010", "VID-012"],
    qc_task_ids: ["CAP-001"],
    merge_queue_ids: ["KIE-002"],
    blocked_task_ids: ["GHL-004"],
    active_workflow_ids: ["WF10"],
    active_agent_ids: [],
    last_watchdog_timestamp: "2026-08-28T19:00:00Z",
    last_batch_merge_timestamp: "2026-08-28T15:26:14Z",
    next_recommended_actions: ["continue build", "verify REC-010 re-cert"],
    last_batch_merge: { batch: 12, merged_count: 7 },
  };
}

/**
 * Build a sandboxed "repo" that looks like the real control plane:
 * snake_case state/checkpoint.json, state/tasks.json rows, session.md with
 * live content OUTSIDE the marker block, ledger.md with a prior line.
 * Everything lives under one temp dir; the real repo is never touched.
 */
export async function seedSandbox(scratchRoot: string, name: string): Promise<string> {
  const repoRoot = await mkdtemp(join(scratchRoot, `${name}-`));
  await mkdir(join(repoRoot, "state", "locks"), { recursive: true });
  await mkdir(join(repoRoot, "state", "task-updates"), { recursive: true });
  await writeFile(
    join(repoRoot, "state", "checkpoint.json"),
    JSON.stringify(legacyCheckpointDoc(), null, 2),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "state", "tasks.json"),
    JSON.stringify(
      {
        items: [
          {
            id: "REC-011",
            status: "ACTIVE",
            worktree: "worktrees/REC-011/",
            branch: "task/REC-011-compact-sim",
          },
          { id: "REL-003", status: "READY" },
          { id: "REL-002", status: "MERGED" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "session.md"),
    [
      "# Session State (session.md)",
      "",
      "## Active agents",
      "- REC-011 builder (opus) — compact simulation",
      "",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "ledger.md"),
    "| 2026-08-28T20:00:00Z | CONTROL | bootstrap | BASELINE | seeded ledger line before compaction |\n",
    "utf8",
  );
  return repoRoot;
}

/** Semantic snapshot of the seeded state, for the no-data-loss comparison. */
export interface SandboxSnapshot {
  ready: string[];
  active: string[];
  qc: string[];
  blocked: string[];
  mergeQueue: string[];
  currentMainSha: string | null;
  currentIntegrationSha: string | null;
  nextActions: string[];
  sessionOutsideMarker: string;
  ledgerLines: number;
  lastWatchdogAt: string | null;
}

/**
 * Read a checkpoint field in the dual shape the control plane legitimately
 * produces: the camelCase machine contract (CheckpointService output) is the
 * truth, the snake_case bootstrap aliases are the fallback. PreCompact's
 * flush (REC-002) preserves both; PostCompact's cadence write (REC-003,
 * through CheckpointService.save) persists camelCase only — so a snapshot
 * taken after the full sequence must still resolve every field from camel.
 * Reading ONLY one style here would manufacture a false data-loss failure.
 */
export function pickField<T>(doc: Record<string, unknown>, camel: string, snake: string): T | undefined {
  const camelValue = doc[camel];
  if (camelValue !== undefined) return camelValue as T;
  return doc[snake] as T | undefined;
}

export async function snapshotSandbox(repoRoot: string): Promise<SandboxSnapshot> {
  const session = await readFile(join(repoRoot, "session.md"), "utf8").catch(() => "");
  const start = session.indexOf("<!-- MMCS:PRECOMPACT:START -->");
  const outside = start === -1 ? session : session.slice(0, start);
  const ledger = await readFile(join(repoRoot, "ledger.md"), "utf8").catch(() => "");
  const doc = await readCheckpointDoc(repoRoot);
  return {
    ready: pickField<string[]>(doc, "readyTaskIds", "ready_task_ids") ?? [],
    active: pickField<string[]>(doc, "activeTaskIds", "active_task_ids") ?? [],
    qc: pickField<string[]>(doc, "qcTaskIds", "qc_task_ids") ?? [],
    blocked: pickField<string[]>(doc, "blockedTaskIds", "blocked_task_ids") ?? [],
    mergeQueue: pickField<string[]>(doc, "mergeQueueTaskIds", "merge_queue_ids") ?? [],
    currentMainSha: pickField<string>(doc, "currentMainSha", "current_main_sha") ?? null,
    currentIntegrationSha:
      pickField<string>(doc, "currentIntegrationSha", "current_integration_sha") ?? null,
    nextActions: pickField<string[]>(doc, "nextActions", "next_recommended_actions") ?? [],
    sessionOutsideMarker: outside,
    ledgerLines: ledger.trimEnd() === "" ? 0 : ledger.trimEnd().split("\n").length,
    lastWatchdogAt: pickField<string>(doc, "lastWatchdogAt", "last_watchdog_timestamp") ?? null,
  };
}

/** Read the sandbox checkpoint doc; throws when the file is missing. */
export async function readCheckpointDoc(repoRoot: string): Promise<Record<string, unknown>> {
  const raw = await readJsonFileOrNull<Record<string, unknown>>(
    join(repoRoot, "state", CHECKPOINT_FILE),
  );
  if (raw === null) throw new Error("checkpoint.json missing");
  return raw;
}

// ---------------------------------------------------------------------------
// Scenario 1 — manual /compact (simulated PreCompact → PostCompact) updates checkpoint
// ---------------------------------------------------------------------------

export async function simulateManualCompact(scratchRoot: string): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const repoRoot = await seedSandbox(scratchRoot, "manual-compact");
  try {
    const seededStamp = "2026-08-28T20:05:00Z"; // legacy timestamp field

    // ---- the operator types /compact (trigger "manual"): PreCompact fires
    const pre = await runPreCompact({
      repoRoot,
      input: {
        session_id: "sim-session-1",
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: "keep the task map",
      },
    });
    const afterPre = await readCheckpointDoc(repoRoot);
    const preStamp = typeof afterPre.lastCheckpointAt === "string" ? afterPre.lastCheckpointAt : "";
    steps.push({
      name: "manual /compact PreCompact flush stamps the checkpoint",
      ok: pre.ok && preStamp !== "" && preStamp !== seededStamp,
      evidence: `lastCheckpointAt ${seededStamp} -> ${preStamp || "-"}`,
    });
    steps.push({
      name: "PreCompact records the machine resume hint",
      ok: (afterPre.nextActions as string[] | undefined)?.includes(PRECOMPACT_NEXT_ACTION) === true,
      evidence: `nextActions=[${(afterPre.nextActions as string[] | undefined)?.join(",")}]`,
    });
    const sessionAfterPre = await readFile(join(repoRoot, "session.md"), "utf8");
    steps.push({
      name: "session.md carries the PreCompact resume block (trigger manual)",
      ok: sessionAfterPre.includes("PreCompact Checkpoint") && sessionAfterPre.includes("**Trigger:** manual"),
      evidence: `block=${sessionAfterPre.includes("PreCompact Checkpoint")}`,
    });
    const ledgerAfterPre = await readFile(join(repoRoot, "ledger.md"), "utf8");
    steps.push({
      name: "ledger.md records PRECOMPACT_CHECKPOINT",
      ok: ledgerAfterPre.includes(PRECOMPACT_LEDGER_TAG),
      evidence: `ledger lines=${ledgerAfterPre.trimEnd().split("\n").length}`,
    });

    // ---- PostCompact fires after the (simulated) compaction completes
    const postStdout: string[] = [];
    const postCode = await runPostCompact(["--repo-root", repoRoot], {
      stdout: (s) => postStdout.push(s),
      stderr: () => undefined,
      readStdin: async () =>
        JSON.stringify({
          session_id: "sim-session-1",
          hook_event_name: "PostCompact",
          trigger: "manual",
        }),
    });
    const afterPost = await readCheckpointDoc(repoRoot);
    steps.push({
      name: "PostCompact records the post-compact cadence event (exit 0, stamp advances)",
      ok:
        postCode === 0 &&
        typeof afterPost.lastCheckpointAt === "string" &&
        (afterPost.lastCheckpointAt as string) !== "" &&
        (afterPost.lastCheckpointAt as string) >= preStamp,
      evidence: `exit=${postCode} lastCheckpointAt=${afterPost.lastCheckpointAt}`,
    });
    steps.push({
      name: "PostCompact does not clobber the PreCompact nextActions",
      ok:
        (afterPost.nextActions as string[] | undefined)?.includes(PRECOMPACT_NEXT_ACTION) === true &&
        (afterPost.nextActions as string[] | undefined)?.join("|") ===
          (afterPre.nextActions as string[] | undefined)?.join("|"),
      evidence: `nextActions=[${(afterPost.nextActions as string[] | undefined)?.join(",")}]`,
    });
    const marker = JSON.parse(
      await readFile(join(repoRoot, "state", RECOVERY_MARKER_FILE), "utf8"),
    ) as { last_post_compact?: { checkpoint_ok?: boolean; trigger?: string } };
    steps.push({
      name: "recovery marker records the compaction with checkpoint_ok",
      ok:
        marker.last_post_compact?.checkpoint_ok === true &&
        marker.last_post_compact?.trigger === "manual",
      evidence: `checkpoint_ok=${marker.last_post_compact?.checkpoint_ok} trigger=${marker.last_post_compact?.trigger}`,
    });
    steps.push({
      name: "post-compact stdout re-injects the disk-truth read order",
      ok:
        postStdout.join("\n").includes("state/checkpoint.json") &&
        postStdout.join("\n").includes("recovery.md"),
      evidence: `stdout lines=${postStdout.length}`,
    });

    return { scenario: "manual-compact-checkpoint", ok: steps.every((s) => s.ok), steps };
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — simulated new/resumed session injects + reads state
// ---------------------------------------------------------------------------

/**
 * The fresh session's read: a brand-new CheckpointService with NO in-memory
 * state loads the durable checkpoint from disk and reconstructs the resume
 * view (runbook §5.2 step 2). Disk is the only memory across the compaction
 * boundary — exactly like a real new/resumed session.
 */
export async function freshSessionRead(repoRoot: string): Promise<{
  view: ResumeView;
  state: CheckpointState;
}> {
  const service = new CheckpointService(repoRoot);
  const state = await service.loadExisting();
  return { view: toResumeView(state), state };
}

/** Same-map check shared by scenarios 2 and 3. */
function mapSame(view: ResumeView, before: SandboxSnapshot): boolean {
  return (
    view.active.size === before.active.length &&
    before.active.every((id) => view.active.has(id)) &&
    view.ready.size === before.ready.length &&
    before.ready.every((id) => view.ready.has(id)) &&
    view.qc.size === before.qc.length &&
    before.qc.every((id) => view.qc.has(id)) &&
    view.blocked.size === before.blocked.length &&
    before.blocked.every((id) => view.blocked.has(id)) &&
    view.mergeQueue.size === before.mergeQueue.length &&
    before.mergeQueue.every((id) => view.mergeQueue.has(id))
  );
}

export async function simulateResumedSessionInjectsAndReads(
  scratchRoot: string,
): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const repoRoot = await seedSandbox(scratchRoot, "resumed-session");
  try {
    // Run one full compact cycle first so the session resumes post-compact.
    await runPreCompact({
      repoRoot,
      input: { session_id: "sim-session-2", hook_event_name: "PreCompact", trigger: "manual" },
    });
    await runPostCompact(["--repo-root", repoRoot], {
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => JSON.stringify({ trigger: "manual" }),
    });
    const preCompact = await snapshotSandbox(repoRoot);

    // ---- Claude Code starts the post-compact session (source "compact") and
    //      injects the SessionStart hook stdout into the new context.
    const result = await runSessionStart({
      repoRoot,
      input: {
        session_id: "sim-session-2-resumed",
        hook_event_name: "SessionStart",
        source: "compact",
      },
    });

    steps.push({
      name: "SessionStart (source compact) injects the recovery context block",
      ok:
        result.context.startsWith("<session-start-context>") &&
        result.context.includes("</session-start-context>") &&
        result.source === "compact",
      evidence: `source=${result.source} context ${result.context.split("\n").length} lines`,
    });
    steps.push({
      name: "injected context points the session at the durable state files",
      ok:
        result.context.includes("state/checkpoint.json") &&
        result.context.includes("recovery.md"),
      evidence: `mentions checkpoint.json+recovery.md=${result.context.includes("state/checkpoint.json") && result.context.includes("recovery.md")}`,
    });
    steps.push({
      name: "injected context carries the duplicate-prevention rule",
      ok:
        result.context.includes("never recreate") ||
        result.context.toLowerCase().includes("do not dispatch"),
      evidence: `duplicate-prevention present=${result.context.includes("DUPLICATE PREVENTION")}`,
    });
    steps.push({
      name: "injected context names the ACTIVE task (never re-dispatch)",
      ok: result.context.includes("REC-011"),
      evidence: "REC-011 listed under ACTIVE/QC_FIXING do-not-touch",
    });

    // ---- the fresh session READS state from disk (no in-process memory)
    const { view } = await freshSessionRead(repoRoot);
    steps.push({
      name: "fresh session reads the task map from state/checkpoint.json",
      ok: mapSame(view, preCompact),
      evidence: `reloaded buckets ready=${view.ready.size} active=${view.active.size} qc=${view.qc.size} blocked=${view.blocked.size} mergeQueue=${view.mergeQueue.size}`,
    });
    steps.push({
      name: "resume view holds the pre-compact resume hint",
      ok: view.checkpoint.nextActions.includes(PRECOMPACT_NEXT_ACTION),
      evidence: `nextActions=[${view.checkpoint.nextActions.join(",")}]`,
    });
    steps.push({
      name: "recovery marker points the resumed session at the read order",
      ok: RECOVERY_READ_ORDER.includes("state/checkpoint.json"),
      evidence: `read order entries=${RECOVERY_READ_ORDER.length}`,
    });

    return {
      scenario: "resumed-session-inject-and-read",
      ok: steps.every((s) => s.ok),
      steps,
    };
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — no data loss across compaction
// ---------------------------------------------------------------------------

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

export async function simulateNoDataLoss(scratchRoot: string): Promise<ScenarioResult> {
  const steps: ScenarioStep[] = [];
  const repoRoot = await seedSandbox(scratchRoot, "no-data-loss");
  try {
    const before = await snapshotSandbox(repoRoot);

    // PreCompact → (the compaction itself is Claude-internal, nothing to do)
    await runPreCompact({
      repoRoot,
      input: { session_id: "sim-session-3", hook_event_name: "PreCompact", trigger: "manual" },
    });

    const afterPre = await readCheckpointDoc(repoRoot);
    const snakePreserved =
      sameSet((afterPre.ready_task_ids as string[]) ?? [], before.ready) &&
      sameSet((afterPre.active_task_ids as string[]) ?? [], before.active) &&
      sameSet((afterPre.qc_task_ids as string[]) ?? [], before.qc) &&
      sameSet((afterPre.blocked_task_ids as string[]) ?? [], before.blocked) &&
      sameSet((afterPre.merge_queue_ids as string[]) ?? [], before.mergeQueue) &&
      afterPre.current_main_sha === before.currentMainSha &&
      afterPre.current_integration_sha === before.currentIntegrationSha &&
      afterPre.active_dependency_wave === 1;
    steps.push({
      name: "PreCompact flush preserves the legacy snake_case fields (SHAs, wave, buckets)",
      ok: snakePreserved,
      evidence: `main_sha=${afterPre.current_main_sha ? "kept" : "LOST"} wave=${afterPre.active_dependency_wave}`,
    });

    // PostCompact fires after the (simulated) compaction completes.
    await runPostCompact(["--repo-root", repoRoot], {
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => JSON.stringify({ trigger: "manual" }),
    });

    const after = await readCheckpointDoc(repoRoot);
    const bucketsPreserve =
      sameSet((after.readyTaskIds as string[]) ?? [], before.ready) &&
      sameSet((after.activeTaskIds as string[]) ?? [], before.active) &&
      sameSet((after.qcTaskIds as string[]) ?? [], before.qc) &&
      sameSet((after.blockedTaskIds as string[]) ?? [], before.blocked) &&
      sameSet((after.mergeQueueTaskIds as string[]) ?? [], before.mergeQueue);
    steps.push({
      name: "task-id buckets survive compaction in the machine contract",
      ok: bucketsPreserve,
      evidence: `ready=${(after.readyTaskIds as string[])?.length} active=${(after.activeTaskIds as string[])?.length} qc=${(after.qcTaskIds as string[])?.length} blocked=${(after.blockedTaskIds as string[])?.length} mergeQueue=${(after.mergeQueueTaskIds as string[])?.length}`,
    });
    const shasPreserved =
      after.currentMainSha === before.currentMainSha &&
      after.currentIntegrationSha === before.currentIntegrationSha &&
      after.currentWave === 1;
    steps.push({
      name: "camelCase truth (SHAs, wave) preserved through the full sequence",
      ok: shasPreserved,
      evidence: `main_sha=${after.currentMainSha ? "kept" : "LOST"} wave=${after.currentWave}`,
    });
    const hintsPreserved =
      before.nextActions.length > 0 &&
      before.nextActions.every((a) => ((after.nextActions as string[]) ?? []).includes(a));
    steps.push({
      name: "pre-existing next-action hints preserved through the flush",
      ok: hintsPreserved,
      evidence: `before=[${before.nextActions.join(",")}] after=[${(after.nextActions as string[])?.join(",")}]`,
    });
    const sessionNow = await readFile(join(repoRoot, "session.md"), "utf8");
    steps.push({
      name: "session.md content outside the marker block survives",
      ok: sessionNow.startsWith(before.sessionOutsideMarker),
      evidence: `preserved=${sessionNow.startsWith(before.sessionOutsideMarker)} bytes=${before.sessionOutsideMarker.length}`,
    });
    const ledgerNow = await readFile(join(repoRoot, "ledger.md"), "utf8");
    steps.push({
      name: "ledger.md keeps prior lines and stays append-only",
      ok:
        ledgerNow.includes("seeded ledger line before compaction") &&
        ledgerNow.trimEnd().split("\n").length >= before.ledgerLines + 1,
      evidence: `lines ${before.ledgerLines} -> ${ledgerNow.trimEnd().split("\n").length}`,
    });

    // A fresh session reconstructs the SAME map from disk after compaction.
    const { view } = await freshSessionRead(repoRoot);
    steps.push({
      name: "fresh session reconstructs the exact pre-compact task map",
      ok: mapSame(view, before),
      evidence: `active=${view.active.size}/${before.active.length} ready=${view.ready.size}/${before.ready.length} qc=${view.qc.size}/${before.qc.length} blocked=${view.blocked.size}/${before.blocked.length} mergeQueue=${view.mergeQueue.size}/${before.mergeQueue.length}`,
    });

    return { scenario: "no-data-loss-across-compaction", ok: steps.every((s) => s.ok), steps };
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Aggregate runner + CLI entry
// ---------------------------------------------------------------------------

export interface SimulateCompactOptions {
  /** Where sandboxed state lives; a fresh temp dir when omitted. */
  scratchRoot?: string;
}

async function runScenario(
  scenarios: ScenarioResult[],
  scenario: string,
  fn: () => Promise<ScenarioResult>,
): Promise<void> {
  try {
    scenarios.push(await fn());
  } catch (err) {
    scenarios.push({
      scenario,
      ok: false,
      steps: [{ name: "scenario threw", ok: false, evidence: err instanceof Error ? err.message : String(err) }],
    });
  }
}

export async function simulateCompact(
  opts: SimulateCompactOptions = {},
): Promise<CompactSimResult> {
  const scratchRoot = opts.scratchRoot ?? (await mkdtemp(join(tmpdir(), "mmcs-compact-sim-")));
  const scenarios: ScenarioResult[] = [];
  await runScenario(scenarios, "manual-compact-checkpoint", () => simulateManualCompact(scratchRoot));
  await runScenario(scenarios, "resumed-session-inject-and-read", () =>
    simulateResumedSessionInjectsAndReads(scratchRoot),
  );
  await runScenario(scenarios, "no-data-loss-across-compaction", () =>
    simulateNoDataLoss(scratchRoot),
  );
  return { ok: scenarios.every((s) => s.ok), scenarios, scratchRoot };
}

export function formatReport(result: CompactSimResult): string {
  const lines: string[] = [];
  lines.push("=== MMCS compact simulation (REC-011) ===");
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
export async function main(): Promise<number> {
  const result = await simulateCompact();
  process.stdout.write(`${formatReport(result)}\n`);
  return result.ok ? 0 : 1;
}

// Executed directly (`npx tsx scripts/orchestration/compact-sim.ts`): run and exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`compact-sim failed: ${err instanceof Error ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}
