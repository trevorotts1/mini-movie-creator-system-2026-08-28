/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";

/**
 * REC-006 — TaskCompleted hook (spec §28 "TaskCompleted: exit 2 blocking when
 * acceptance/QC evidence is missing (no ACTIVE→MERGED jumps)"; runbook §6
 * "block with exit 2 when acceptance/QC evidence missing: task ID in
 * state/tasks.json; test evidence recorded; QC PASS where required; no
 * ACTIVE→MERGED jump; branch/worktree captured. Feedback tells the agent
 * exactly what remains"; todo.md TASK-REC-006).
 *
 * Contract — the gate is READ-ONLY over control state and fails closed:
 *
 * 1. read the hook JSON from stdin and extract the task id (`task_id` /
 *    `taskId`, or the `--task-id` flag). No task id → exit 2: an unnamed
 *    task cannot be verified.
 * 2. ids that do not match the MMCS task-id vocabulary (`ABC-123`) are not
 *    MMCS tasks (e.g. the harness task tool's numeric ids) — allow, exit 0.
 * 3. task must exist in `state/tasks.json` → else exit 2 ("not registered").
 * 4. record must capture `branch` and `worktree` → exit 2 naming the gap.
 * 5. builder test evidence `state/task-updates/<ID>.builder.json` must exist
 *    with a non-empty `testsRun` that does not record FAIL → else exit 2.
 * 6. QC evidence `state/task-updates/<ID>.qc.json` must have `phase: PASS`
 *    and no open blockers — "where required": required unless the task
 *    record itself opts out with `qcRequired: false` (the runbook's
 *    "QC PASS where required" lever; every workflow task defaults to
 *    required — batch-merge admits only Sonnet-QC-PASS, so relaxing it for
 *    a normal task would strand it in the merge queue anyway).
 * 7. ACTIVE→MERGED jump: a record marked MERGED without the full builder +
 *    QC PASS evidence trail is a status jump → exit 2 naming it.
 * 8. all evidence present → exit 0 and the close proceeds.
 *
 * Every block enumerates ALL remaining gaps (not just the first) in one
 * stderr message — Claude Code feeds stderr back to the agent on exit 2.
 * Live worktree/branch reconciliation vs recorded state stays with the
 * watchdog (REC-008); this gate verifies the RECORD, not the filesystem.
 *
 * Entry point chain: `.claude/hooks/task-completed.sh` (executable,
 * registered in `.claude/settings.json`) → this module via tsx. Repo root
 * resolution: `--repo-root` flag, then `MMCS_REPO_ROOT`, then cwd.
 */

export const MMCS_TASK_ID_PATTERN = /^[A-Z]{2,6}-\d{1,4}$/;
export const GATE_LEDGER_TAG = "TASK_COMPLETED_GATE";

export interface TaskRecord {
  id?: string;
  branch?: string;
  worktree?: string;
  status?: string;
  qcRequired?: boolean;
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
  blockers?: unknown[];
}

/** Hook JSON payload Claude Code pipes to TaskCompleted hooks (tolerant). */
export interface TaskCompletedHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  task?: { id?: unknown; task_id?: unknown; taskId?: unknown };
}

/** Coerce the loose hook payload into the strings we evaluate. */
export function normalizeInput(raw: unknown): { taskId: string; sessionId: string } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as TaskCompletedHookInput;
  // Numbers coerce to their string form so the harness task tool's numeric
  // ids reach the NOT_MMCS_TASK allow path — collapsing them to "" here
  // would false-block a non-MMCS close with NO_TASK_ID.
  const str = (v: unknown): string =>
    typeof v === "string" && v.trim() !== ""
      ? v.trim()
      : typeof v === "number" && Number.isFinite(v)
        ? String(v)
        : "";
  const task = obj.task && typeof obj.task === "object" ? obj.task : undefined;
  return {
    taskId:
      str(obj.task_id) || str(obj.taskId) || str(task?.id) || str(task?.task_id) || str(task?.taskId),
    sessionId: str(obj.session_id),
  };
}

/** Read all of stdin; never throws on an empty/closed stream. */
export async function readStdinJson(
  input?: { stdin?: NodeJS.ReadableStream } | undefined,
): Promise<unknown> {
  // Narrow to Readable so .on(...) has one coherent signature — the
  // NodeJS.ReadableStream union mixes ReadableStream/ReadStream overloads.
  const stream: Readable =
    input?.stdin instanceof Readable ? input.stdin : (process.stdin as Readable);
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    // Chunks may arrive as strings (object-mode streams, Readable.from(["..."]));
    // coerce before Buffer.concat, which only accepts Buffers.
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk),
    );
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    stream.on("error", () => resolve(null));
  });
}

/** Minimal `state/tasks.json` reader — tolerant of corrupt/legacy shapes. */
export async function readTasksJson(
  filePath: string,
): Promise<Map<string, TaskRecord>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return new Map();
  }
  const out = new Map<string, TaskRecord>();
  try {
    const doc = JSON.parse(raw) as { items?: TaskRecord[] };
    for (const t of Array.isArray(doc.items) ? doc.items : []) {
      if (typeof t?.id === "string") out.set(t.id, t);
    }
  } catch {
    /* corrupt tasks.json — the gate cannot verify against it */
  }
  return out;
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface GateOutcome {
  /** true → the close may proceed (exit 0). */
  allowed: boolean;
  taskId: string;
  /** Exact remaining gaps, each a complete sentence, in check order. */
  remaining: string[];
  reason: string;
}

export interface EvaluateOptions {
  /** Skip the QC-PASS requirement (task record `qcRequired: false`). */
  now?: () => Date;
}

/**
 * The gate. Read-only over `state/tasks.json` + `state/task-updates/`.
 * Collects every remaining gap so the feedback names exactly what remains.
 */
export async function evaluateTaskCompletion(
  repoRoot: string,
  taskId: string,
  _opts: EvaluateOptions = {},
): Promise<GateOutcome> {
  const remaining: string[] = [];

  if (!taskId || taskId.trim() === "") {
    return {
      allowed: false,
      taskId: "",
      remaining: [
        "no task ID in the hook payload — include task_id in the hook JSON or pass --task-id so the gate can verify evidence",
      ],
      reason: "NO_TASK_ID",
    };
  }
  const id = taskId.trim();
  if (!MMCS_TASK_ID_PATTERN.test(id)) {
    // Not an MMCS task id (e.g. the harness task tool's numeric ids) — the
    // MMCS evidence gate has no opinion about it.
    return { allowed: true, taskId: id, remaining: [], reason: "NOT_MMCS_TASK" };
  }

  const updatesDir = join(repoRoot, "state", "task-updates");

  // 3. task registered in state/tasks.json.
  const tasks = await readTasksJson(join(repoRoot, "state", "tasks.json"));
  const record = tasks.get(id);
  if (!record) {
    remaining.push(
      `task ${id} is not registered in state/tasks.json — add the task record (id, branch, worktree, status) before closing it`,
    );
    return {
      allowed: false,
      taskId: id,
      remaining,
      reason: "TASK_NOT_REGISTERED",
    };
  }

  // 4. branch/worktree captured.
  if (!record.branch || record.branch.trim() === "") {
    remaining.push(
      `task ${id} records no branch — set "branch" in its state/tasks.json record (e.g. task/${id}-<slug>) before closing`,
    );
  }
  if (!record.worktree || record.worktree.trim() === "") {
    remaining.push(
      `task ${id} records no worktree — set "worktree" in its state/tasks.json record (e.g. worktrees/${id}/) before closing`,
    );
  }

  // 5. builder test evidence.
  const builder = await readJsonOrNull<BuilderUpdateEvidence>(
    join(updatesDir, `${id}.builder.json`),
  );
  if (!builder) {
    remaining.push(
      `no builder test evidence for task ${id} — write state/task-updates/${id}.builder.json with the exact test commands + result in "testsRun" (phase BUILDER_DONE)`,
    );
  } else {
    const testsRun = (builder.testsRun ?? "").trim();
    if (testsRun === "") {
      remaining.push(
        `builder evidence for task ${id} has an empty "testsRun" — record the exact commands + result (e.g. "npx vitest run ... → 12/12 PASS")`,
      );
    } else if (/FAIL/i.test(testsRun) && !/0 FAIL|NO FAIL|failures?\s*:\s*0/i.test(testsRun)) {
      remaining.push(
        `builder test evidence for task ${id} records FAIL — fix the failures, rerun, and update "testsRun" before closing`,
      );
    }
  }

  // 6. QC PASS where required (record-level opt-out only).
  const qcRequired = record.qcRequired !== false;
  let qcPass = false;
  if (qcRequired) {
    const qc = await readJsonOrNull<QcEvidence>(join(updatesDir, `${id}.qc.json`));
    if (!qc) {
      remaining.push(
        `no QC evidence for task ${id} — a Sonnet QC round must write state/task-updates/${id}.qc.json (phase PASS) before the task may close`,
      );
    } else if (qc.phase !== "PASS") {
      remaining.push(
        `QC verdict for task ${id} is ${qc.phase ?? "UNSET"}, not PASS — resolve the QC defects and rerun QC before closing`,
      );
      if (Array.isArray(qc.blockers) && qc.blockers.length > 0) {
        remaining.push(
          `QC evidence for task ${id} lists open blockers (${qc.blockers.length}) — clear them before closing`,
        );
      }
    } else {
      qcPass = true;
      if (Array.isArray(qc.blockers) && qc.blockers.length > 0) {
        qcPass = false;
        remaining.push(
          `QC PASS for task ${id} still lists open blockers (${qc.blockers.length}) — clear them in state/task-updates/${id}.qc.json before closing`,
        );
      }
    }
  }

  // 7. ACTIVE→MERGED jump: MERGED without the full evidence trail.
  // A record-level qcRequired: false opt-out (check 6) means QC PASS is not
  // part of this task's trail — it must not manufacture a false jump.
  const status = (record.status ?? "").trim().toUpperCase();
  const hasBuilder = builder !== null;
  const qcSatisfied = !qcRequired || qcPass;
  if (status === "MERGED" && (!hasBuilder || !qcSatisfied)) {
    remaining.push(
      `ACTIVE→MERGED jump: task ${id} is marked MERGED but the evidence trail is incomplete (builder evidence: ${hasBuilder ? "present" : "missing"}, QC PASS: ${qcSatisfied ? (qcRequired ? "present" : "not required") : "missing"}) — a task may only be MERGED after BUILDER_DONE + QC PASS`,
    );
  }

  if (remaining.length > 0) {
    return { allowed: false, taskId: id, remaining, reason: "EVIDENCE_INCOMPLETE" };
  }
  return { allowed: true, taskId: id, remaining: [], reason: "EVIDENCE_COMPLETE" };
}

function formatFeedback(outcome: GateOutcome): string {
  const lines = [
    `TaskCompleted gate: BLOCKED — task ${outcome.taskId || "(unknown)"} cannot close yet.`,
    "Remaining:",
    ...outcome.remaining.map((r, i) => `  ${i + 1}. ${r}`),
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI — invoked by .claude/hooks/task-completed.sh. Exit 0 when the evidence
// trail is complete (close proceeds); exit 2 (blocking feedback to the agent)
// when any gap remains — fail closed.
// ---------------------------------------------------------------------------

export interface HookCliOptions {
  repoRoot?: string;
  taskId?: string;
  help?: boolean;
  selftest?: boolean;
}

const USAGE = `Usage: npx tsx scripts/hooks/task-completed.ts [options]  < hook.json

TaskCompleted hook (REC-006): exit 2 blocks premature close when
acceptance/QC evidence is missing (task not in state/tasks.json; no test
evidence; no QC PASS; ACTIVE→MERGED jump; branch/worktree unrecorded).
Feedback names exactly what remains. Exit 0 when the evidence is complete.

Options:
  --repo-root <path>   Repo root (default: $MMCS_REPO_ROOT, else cwd)
  --task-id <ID>       Task id when the hook payload carries none
  --selftest           Run the built-in simulated-invocation self-test
  --help               This help
`;

export function parseArgs(argv: readonly string[]): HookCliOptions {
  const opts: HookCliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo-root":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.repoRoot = argv[i];
        break;
      case "--task-id":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.taskId = argv[i];
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

/**
 * Simulated hook invocation used by --selftest and the vitest suite: builds a
 * temp repo fixture with one fully-evidenced task and one missing-evidence
 * task, then verifies the gate allows the first and blocks the second with
 * named gaps.
 */
export async function selftest(log: (line: string) => void = () => undefined): Promise<void> {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mmcs-taskcompleted-selftest-"));
  try {
    const updates = join(dir, "state", "task-updates");
    await mkdir(updates, { recursive: true });
    const good = "TST-001";
    const bad = "TST-002";
    const tasksDoc = {
      schema_version: 1,
      updated_at: "2026-08-28T00:00:00Z",
      items: [
        { id: good, status: "PASS", branch: `task/${good}-fixture`, worktree: `worktrees/${good}/` },
        { id: bad, status: "ACTIVE", branch: "", worktree: "" },
      ],
    };
    await writeFile(join(dir, "state", "tasks.json"), JSON.stringify(tasksDoc, null, 2));
    await writeFile(
      join(updates, `${good}.builder.json`),
      JSON.stringify({ taskId: good, phase: "BUILDER_DONE", testsRun: "npx vitest run x → 3/3 PASS" }),
    );
    await writeFile(
      join(updates, `${good}.qc.json`),
      JSON.stringify({ taskId: good, phase: "PASS", finalTestResult: "PASS", blockers: [] }),
    );

    const allow = await evaluateTaskCompletion(dir, good);
    if (!allow.allowed) throw new Error(`selftest: evidenced task ${good} should pass, got ${allow.reason}`);
    const block = await evaluateTaskCompletion(dir, bad);
    if (block.allowed) throw new Error(`selftest: evidence-less task ${bad} should be blocked`);
    if (block.remaining.length < 2) {
      throw new Error(`selftest: expected branch+worktree gaps named, got ${block.remaining.length}`);
    }
    const unregistered = await evaluateTaskCompletion(dir, "TST-003");
    if (unregistered.allowed) throw new Error("selftest: unregistered task should be blocked");
    log(`selftest: ${good} allowed; ${bad} blocked with ${block.remaining.length} named gaps; unregistered blocked`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log("TASKCOMPLETED SELFTEST PASS");
}

/** Run the hook CLI; returns the process exit code. */
export async function runHook(
  argv: readonly string[],
  io: {
    stdin?: NodeJS.ReadableStream;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
  } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  let opts: HookCliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr(`task-completed hook: ${(err as Error).message}\n\n${USAGE}`);
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
    const repoRoot = opts.repoRoot ?? process.env.MMCS_REPO_ROOT ?? process.cwd();
    const rawInput = await readStdinJson({ stdin: io.stdin });
    const { taskId: payloadTaskId } = normalizeInput(rawInput);
    const taskId = opts.taskId ?? payloadTaskId;
    const outcome = await evaluateTaskCompletion(repoRoot, taskId);
    if (outcome.allowed) {
      io.stdout(
        `task-completed gate: ALLOW task ${outcome.taskId} (${outcome.reason})\n`,
      );
      return 0;
    }
    // Exit 2 + stderr = blocking feedback: Claude Code surfaces this to the
    // agent so it names exactly what remains before the close re-fires.
    io.stderr(formatFeedback(outcome));
    return 2;
  } catch (err) {
    // Fail closed: an unusable gate is a blocked close, never a silent pass.
    io.stderr(
      `task-completed gate FAILED (blocked close) — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runHook(process.argv.slice(2));
}

// Run only when THIS module is the entry program (hook script / selftest),
// never on import from tests. Same guard pattern as REC-001/REC-002.
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
