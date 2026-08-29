/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

/**
 * REC-007 — TeammateIdle hook (runbook §6 "TeammateIdle"; todo.md TASK-REC-007;
 * spec §28 "Hooks": "TeammateIdle: exit 2 with continue instruction when the
 * teammate owns ACTIVE/QC_FIXING work; else allow idle").
 *
 * Claude Code runs this hook whenever a teammate goes idle inside an agent
 * team. The hook is a PURE DECISION gate — it reads orchestration state and
 * either blocks the idle (exit 2, stderr becomes the continue instruction fed
 * back to the teammate) or allows it (exit 0). It never writes: the idle
 * decision must be cheap and side-effect free, unlike PreCompact's flush.
 *
 * Decision order (runbook §4.1 status vocabulary):
 *
 *   1. Resolve the teammate's identity from the hook payload (agent id /
 *      teammate name fields), then `--agent`, then MMCS_AGENT_ID, and an
 *      optional direct MMCS_TASK_ID claim. An unresolvable identity owns
 *      nothing provable → idle is allowed (fail-open: a broken state store
 *      must not wedge every teammate into a blocked-idle loop; the watchdog,
 *      not this hook, flags state corruption).
 *   2. Owned in-flight work — tasks mapped to this teammate in
 *      `state/agents.json` whose `state/tasks.json` status is ACTIVE or
 *      QC_FIXING → exit 2 with a continue instruction naming the tasks.
 *   3. No owned work, but a compatible READY task exists in the teammate's
 *      own workflow (deps satisfied, not already claimed by another agent)
 *      → exit 2 directing the teammate to claim the next one.
 *   4. Otherwise → exit 0. No useful work; idle is correct.
 *
 * Entry point chain: `.claude/hooks/teammate-idle.sh` (executable, registered
 * in `.claude/settings.json`) → this module via tsx. Repo root resolution:
 * `--repo-root` flag, then `MMCS_REPO_ROOT`, then cwd.
 */

// ---------------------------------------------------------------------------
// State document shapes — field-tolerant mirrors of state/*.json as written
// by the orchestrator (same reading discipline as the watchdog, REC-008).
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id?: string;
  title?: string;
  workflow?: string;
  dependsOn?: string[];
  status?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentRecord {
  id?: string;
  name?: string;
  workflow?: string;
  taskId?: string;
  task_id?: string;
  state?: string;
  role?: string;
}

export interface TasksDoc {
  schema_version?: number;
  updated_at?: string;
  items?: TaskRecord[];
}

export interface AgentsDoc {
  schema_version?: number;
  updated_at?: string;
  items?: AgentRecord[];
}

/** Hook JSON payload Claude Code pipes to TeammateIdle hooks. */
export interface TeammateIdleHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  teammate_name?: unknown;
  teammateName?: unknown;
  agent_id?: unknown;
  agentId?: unknown;
  agent_name?: unknown;
  agentName?: unknown;
  name?: unknown;
}

/** Statuses that mean the teammate still owns in-flight work (runbook §4.1). */
export const IN_FLIGHT_STATUSES = ["ACTIVE", "QC_FIXING"] as const;

/** Statuses that satisfy a task dependency (same closure as the watchdog). */
export const SATISFYING_STATUSES = ["PASS", "MERGED", "DONE"] as const;

export type IdleDecision = {
  decision: "continue-owned" | "claim-ready" | "allow-idle";
  exitCode: 0 | 2;
  agent: string;
  workflow: string;
  /** Tasks the teammate owns that are still in flight. */
  owned: TaskRecord[];
  /** Ready tasks the teammate should claim next (claim-ready branch). */
  suggestions: TaskRecord[];
};

// ---------------------------------------------------------------------------
// Payload / identity normalization
// ---------------------------------------------------------------------------

const str = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : "";

/** Coerce the loose hook payload into the identity strings we act on. */
export function normalizeInput(raw: unknown): { agent: string; sessionId: string } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as TeammateIdleHookInput;
  const agent =
    str(obj.teammate_name) ||
    str(obj.teammateName) ||
    str(obj.agent_id) ||
    str(obj.agentId) ||
    str(obj.agent_name) ||
    str(obj.agentName) ||
    str(obj.name);
  return { agent, sessionId: str(obj.session_id) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Field-tolerant JSON read: missing/unreadable file → null, never a throw. */
async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.trim() === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Every agents.json record that matches the teammate identity (id or name). */
export function matchingAgentRecords(
  agents: AgentRecord[],
  agent: string,
): AgentRecord[] {
  if (agent === "") return [];
  const wanted = agent.toLowerCase();
  return agents.filter(
    (a) =>
      str(a.id).toLowerCase() === wanted || str(a.name).toLowerCase() === wanted,
  );
}

/** Task ids the records map to (taskId, tolerating task_id). */
export function taskIdsFromRecords(records: AgentRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const id = str(r.taskId) || str(r.task_id);
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Deterministic natural ordering: WF04 before WF10, VID-002 before VID-014. */
export function compareTaskIds(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  const len = Math.min(na.length, nb.length);
  for (let i = 0; i < len; i += 1) {
    if (na[i] !== nb[i]) return na[i] - nb[i];
  }
  return a.localeCompare(b);
}

/** Deps satisfied closure — identical to the watchdog's semantics. */
export function dependenciesSatisfied(
  task: TaskRecord,
  statusOf: Map<string, string>,
): boolean {
  for (const dep of task.dependsOn ?? []) {
    if (!SATISFYING_STATUSES.includes((statusOf.get(dep) ?? "") as never)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface DecideInput {
  tasks: TaskRecord[];
  agents: AgentRecord[];
  /** Resolved teammate identity ("": unresolvable). */
  agent: string;
  /** Direct task claim override (MMCS_TASK_ID / --task). */
  taskOverride?: string;
  /** Workflow override (MMCS_WORKFLOW / --workflow). */
  workflowOverride?: string;
}

/**
 * Pure decision over already-read state. Throws only on contract misuse;
 * every data-shaped anomaly (missing files, bad statuses) degrades toward
 * allow-idle per the fail-open contract.
 */
export function decide(input: DecideInput): IdleDecision {
  const { tasks, agents, agent } = input;
  const byId = new Map<string, TaskRecord>();
  for (const t of tasks) {
    if (str(t.id) !== "") byId.set(str(t.id), t);
  }
  const statusOf = new Map<string, string>();
  for (const t of tasks) {
    if (str(t.id) !== "" && str(t.status) !== "") statusOf.set(str(t.id), str(t.status));
  }

  // 1. Ownership. Identity may come direct (MMCS_TASK_ID) or via agents.json.
  const records = matchingAgentRecords(agents, agent);
  const ownedIds = new Set<string>(taskIdsFromRecords(records));
  if (str(input.taskOverride) !== "") ownedIds.add(str(input.taskOverride));
  const owned = [...ownedIds]
    .map((id) => byId.get(id))
    .filter((t): t is TaskRecord => t !== undefined)
    .filter((t) => (IN_FLIGHT_STATUSES as readonly string[]).includes(str(t.status)))
    .sort((a, b) => compareTaskIds(str(a.id), str(b.id)));

  if (owned.length > 0) {
    return {
      decision: "continue-owned",
      exitCode: 2,
      agent,
      workflow: str(input.workflowOverride) || str(records[0]?.workflow) || str(byId.get(str(owned[0].id))?.workflow),
      owned,
      suggestions: [],
    };
  }

  // 2. No owned in-flight work → claimable READY work in the same workflow.
  // Workflow of the teammate: override > agents.json record > workflow of any
  // task the agent is recorded against (even a finished one). Unknown
  // workflow → nothing provably compatible → allow idle.
  const workflow =
    str(input.workflowOverride) || str(records[0]?.workflow) || workflowOfTaskIds(byId, taskIdsFromRecords(records));
  if (workflow === "") {
    return { decision: "allow-idle", exitCode: 0, agent, workflow: "", owned: [], suggestions: [] };
  }

  // Tasks already claimed by some other recorded agent are not claimable.
  const claimedByOthers = new Set<string>();
  for (const a of agents) {
    const id = str(a.taskId) || str(a.task_id);
    if (id === "") continue;
    if (agent !== "" && (str(a.id).toLowerCase() === agent.toLowerCase() || str(a.name).toLowerCase() === agent.toLowerCase())) {
      continue;
    }
    claimedByOthers.add(id);
  }

  const suggestions = tasks
    .filter((t) => str(t.status) === "READY")
    .filter((t) => str(t.workflow) === workflow)
    .filter((t) => !claimedByOthers.has(str(t.id)))
    .filter((t) => dependenciesSatisfied(t, statusOf))
    .sort((a, b) => compareTaskIds(str(a.id), str(b.id)))
    .slice(0, CLAIM_SUGGESTION_LIMIT);

  if (suggestions.length > 0) {
    return {
      decision: "claim-ready",
      exitCode: 2,
      agent,
      workflow,
      owned: [],
      suggestions,
    };
  }

  // 3. No useful work — idle is correct.
  return { decision: "allow-idle", exitCode: 0, agent, workflow, owned: [], suggestions: [] };
}

function workflowOfTaskIds(
  byId: Map<string, TaskRecord>,
  ids: string[],
): string {
  for (const id of ids) {
    const wf = str(byId.get(id)?.workflow);
    if (wf !== "") return wf;
  }
  return "";
}

/** Cap the claim directive so the instruction stays one readable message. */
export const CLAIM_SUGGESTION_LIMIT = 3;

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export function renderInstruction(d: IdleDecision): string {
  const who = d.agent === "" ? "teammate" : d.agent;
  if (d.decision === "continue-owned") {
    const list = d.owned
      .map((t) => `${str(t.id)} (${str(t.status) || "unknown"})`)
      .join(", ");
    const next =
      d.workflow === ""
        ? ""
        : ` When that work reaches BUILDER_DONE and its update file is written, claim the next compatible READY task in ${d.workflow}.`;
    return (
      `IDLE BLOCKED — you own in-flight work: ${list}. Do not idle. Continue the task: ` +
      `finish the implementation, run its test commands, write state/task-updates/<TASK-ID>.builder.json, ` +
      `and commit on the task branch.${next}`
    );
  }
  if (d.decision === "claim-ready") {
    const list = d.suggestions
      .map((t) => `${str(t.id)}${t.title ? ` — ${t.title}` : ""}`)
      .join("; ");
    return (
      `IDLE BLOCKED — no in-flight work is yours, but compatible READY work exists in workflow ${d.workflow}: ` +
      `${list}. Claim the next one (create worktrees/<TASK-ID>/ from origin/integration, build to its ` +
      `acceptance criteria, commit, write state/task-updates/<TASK-ID>.builder.json). Do not idle.`
    );
  }
  return `TeammateIdle: allowing idle for ${who} — no owned ACTIVE/QC_FIXING task and no compatible READY task to claim.`;
}

// ---------------------------------------------------------------------------
// Hook entry
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

export interface RunTeammateIdleOptions {
  repoRoot: string;
  input?: unknown;
  agent?: string;
  taskOverride?: string;
  workflowOverride?: string;
  now?: () => string;
}

/** Full decision against a repo root's state files. Throws on unreadable state. */
export async function runTeammateIdle(
  opts: RunTeammateIdleOptions,
): Promise<{ decision: IdleDecision; instruction: string; at: string }> {
  const repoRoot = opts.repoRoot;
  if (!repoRoot || repoRoot.trim() === "") {
    throw new Error("repoRoot is required");
  }
  const payload = normalizeInput(opts.input);
  const agent =
    str(opts.agent) || payload.agent || str(process.env.MMCS_AGENT_ID);
  const taskOverride = str(opts.taskOverride) || str(process.env.MMCS_TASK_ID);
  const workflowOverride =
    str(opts.workflowOverride) || str(process.env.MMCS_WORKFLOW);

  const tasksDoc = await readJsonOrNull<TasksDoc>(join(repoRoot, "state", "tasks.json"));
  const agentsDoc = await readJsonOrNull<AgentsDoc>(join(repoRoot, "state", "agents.json"));
  if (tasksDoc === null) {
    // Fail-open: without the task store we cannot prove owned work exists.
    // Allow idle but say why — the watchdog owns flagging state corruption.
    const empty: IdleDecision = {
      decision: "allow-idle",
      exitCode: 0,
      agent,
      workflow: "",
      owned: [],
      suggestions: [],
    };
    return {
      decision: empty,
      instruction:
        `TeammateIdle: allowing idle for ${agent || "teammate"} — state/tasks.json unreadable, ` +
        `no work can be proven owned. This is fail-open; the watchdog should flag the state store.`,
      at: (opts.now ?? nowIso)(),
    };
  }

  const decision = decide({
    tasks: tasksDoc.items ?? [],
    agents: agentsDoc?.items ?? [],
    agent,
    taskOverride,
    workflowOverride,
  });
  return { decision, instruction: renderInstruction(decision), at: (opts.now ?? nowIso)() };
}

// ---------------------------------------------------------------------------
// CLI — invoked by .claude/hooks/teammate-idle.sh. Exit 0 = idle allowed;
// exit 2 = block the idle, stderr carries the continue instruction.
// ---------------------------------------------------------------------------

export interface HookCliOptions {
  repoRoot?: string;
  agent?: string;
  task?: string;
  workflow?: string;
  help?: boolean;
  selftest?: boolean;
}

const USAGE = `Usage: npx tsx scripts/hooks/teammate-idle.ts [options]  < hook.json

TeammateIdle hook (REC-007): decides whether an idling teammate must continue.
Exit 0 = allow idle. Exit 2 = block the idle; stderr is the continue
instruction (finish owned ACTIVE/QC_FIXING work, or claim the next compatible
READY task in the same workflow). Read-only: never writes state.

Options:
  --repo-root <path>   Repo root (default: $MMCS_REPO_ROOT, else cwd)
  --agent <id>         Teammate identity when stdin has none
  --task <task-id>     Direct task-claim override (else $MMCS_TASK_ID)
  --workflow <wf-id>   Workflow override (else $MMCS_WORKFLOW)
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
      case "--agent":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.agent = argv[i];
        break;
      case "--task":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.task = argv[i];
        break;
      case "--workflow":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.workflow = argv[i];
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
 * fixture repo (tasks + agents state), pipes realistic payloads through the
 * full decision, and verifies both branches plus the fail-open path.
 */
export async function selftest(log: (line: string) => void = () => undefined): Promise<void> {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mmcs-teammateidle-selftest-"));
  try {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(
      join(dir, "state", "tasks.json"),
      JSON.stringify({
        schema_version: 1,
        updated_at: "2026-08-28T00:00:00.000Z",
        items: [
          { id: "MERGED-1", title: "Done dep", workflow: "WF1", status: "MERGED", dependsOn: [] },
          { id: "WF1-001", title: "In-flight", workflow: "WF1", status: "ACTIVE", dependsOn: [] },
          { id: "WF1-002", title: "Claimable", workflow: "WF1", status: "READY", dependsOn: ["MERGED-1"] },
          { id: "WF1-003", title: "Deps open", workflow: "WF1", status: "READY", dependsOn: ["OPEN-1"] },
          { id: "WF2-001", title: "Other workflow", workflow: "WF2", status: "READY", dependsOn: [] },
        ],
      }),
    );
    await writeFile(
      join(dir, "state", "agents.json"),
      JSON.stringify({
        schema_version: 1,
        updated_at: "2026-08-28T00:00:00.000Z",
        items: [
          { id: "agent-a", workflow: "WF1", taskId: "WF1-001" },
          { id: "agent-b", workflow: "WF1" },
          { id: "agent-c", workflow: "WF1" },
        ],
      }),
    );

    // Branch 1: teammate owns an ACTIVE task → exit 2 + continue instruction.
    const owned = await runTeammateIdle({
      repoRoot: dir,
      input: { session_id: "s1", hook_event_name: "TeammateIdle", teammate_name: "agent-a" },
    });
    if (owned.decision.exitCode !== 2 || owned.decision.decision !== "continue-owned") {
      throw new Error("owned ACTIVE work did not block idle");
    }
    if (!owned.instruction.includes("WF1-001") || !owned.instruction.includes("IDLE BLOCKED")) {
      throw new Error("continue instruction does not name the owned task");
    }

    // Branch 2: no owned work → directed to the next compatible READY task.
    const claim = await runTeammateIdle({
      repoRoot: dir,
      input: { session_id: "s2", hook_event_name: "TeammateIdle", teammate_name: "agent-c" },
    });
    if (claim.decision.exitCode !== 2 || claim.decision.decision !== "claim-ready") {
      throw new Error("compatible READY work did not block idle");
    }
    const ids = claim.decision.suggestions.map((t) => t.id);
    if (!ids.includes("WF1-002")) throw new Error("claimable READY task missing");
    if (ids.includes("WF1-003")) throw new Error("task with unsatisfied deps suggested");
    if (ids.includes("WF2-001")) throw new Error("other-workflow task suggested");

    // Branch 3: nothing compatible → idle allowed (exit 0).
    const idle = await runTeammateIdle({
      repoRoot: dir,
      agent: "agent-c",
      workflowOverride: "WF9",
    });
    if (idle.decision.exitCode !== 0 || idle.decision.decision !== "allow-idle") {
      throw new Error("idle was not allowed with no useful work");
    }

    // Fail-open: unreadable state must not block idle.
    const failOpen = await runTeammateIdle({
      repoRoot: join(dir, "no-such-root"),
      agent: "agent-a",
    });
    if (failOpen.decision.exitCode !== 0) {
      throw new Error("unreadable state must fail open to allow-idle");
    }

    log("teammate-idle selftest: continue-owned / claim-ready / allow-idle / fail-open verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log("TEAMMATE-IDLE SELFTEST PASS");
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
    io.stderr(`teammate-idle hook: ${(err as Error).message}\n\n${USAGE}`);
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
    const result = await runTeammateIdle({
      repoRoot,
      input: rawInput,
      agent: opts.agent,
      taskOverride: opts.task,
      workflowOverride: opts.workflow,
    });
    if (result.decision.exitCode === 2) {
      io.stderr(`${result.instruction}\n`);
      return 2;
    }
    if (result.decision.decision === "allow-idle" && (opts.repoRoot ?? "") !== "" && result.decision.workflow === "") {
      // Quiet allow on the normal path; the fail-open variant already carries
      // its reason in the instruction, surfaced on stdout here for operators.
      io.stdout(`${result.instruction}\n`);
    } else if (result.decision.decision === "allow-idle") {
      io.stdout(`${result.instruction}\n`);
    }
    return 0;
  } catch (err) {
    // Fail-open even on unexpected errors: an idle gate must never wedge the
    // team. The watchdog, not this hook, owns flagging broken state.
    io.stdout(
      `TeammateIdle: allowing idle — hook error (fail-open): ${(err as Error).message}\n`,
    );
    return 0;
  }
}

/** Read all of stdin; never throws on an empty/closed stream. */
export async function readStdinJson(
  input?: { stdin?: NodeJS.ReadableStream } | undefined,
): Promise<unknown> {
  const stream: Readable =
    input?.stdin instanceof Readable ? input.stdin : (process.stdin as Readable);
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
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
        resolve(null); // tolerated: identity falls back to flags/env
      }
    });
    stream.on("error", () => resolve(null));
  });
}

async function main(): Promise<void> {
  process.exitCode = await runHook(process.argv.slice(2));
}

// Run only when THIS module is the entry program (hook script / selftest),
// never on import from tests. Same guard pattern as the REC-002 hook.
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
