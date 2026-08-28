/// <reference types="node" />
/**
 * MMCS batch merge engine (runbook §7.2, §11, §23; spec.md §28 "Ten-minute
 * loops" — batch merge half; task REC-009).
 *
 * One cycle, exactly the runbook order:
 *   1.  acquire state/locks/merge.lock (exclusive; stale locks broken)
 *   2.  read integration-queue.md + state/merge-queue.json + state/tasks.json
 *   3.  ignore anything without Sonnet QC PASS (state/task-updates/<ID>.qc.json)
 *   4.  ignore failing tests (qc finalTestResult must be PASS)
 *   5.  sort by dependency order, then conflict risk, then task id
 *   6.  conflict pre-check via `git merge-tree --write-tree` (no worktree needed)
 *   7.  merge compatible approved commits as one batch (CAS update-ref)
 *   8.  conflicts are NEVER resolved here — reported for the dedicated merge
 *       workflow's visible conflict resolvers (spec.md §28)
 *   9.  affected-area regression after the batch
 *   10. regression fail → batch reverted, culprits isolated item-by-item
 *   11. push integration only after regression passes
 *   12. mark MERGED in control state (state/tasks.json)
 *   13. remove from merge queue (state/merge-queue.json + checkpoint + queue md)
 *   14. append evidence to logs/merges/ + ledger.md
 *   15. release lock
 *
 * No QC PASS = no merge. Integration is never left broken: every mutation of
 * the integration ref is compare-and-swap against the head we planned from,
 * and any regression failure reverts the whole batch before reporting.
 *
 * `dryRun` computes the full admission + ordering + conflict plan and mutates
 * nothing — no refs, no files, no pushes (acceptance: "dry-run mode test on
 * fixture queue").
 *
 * Git and regression are injected adapters; tests drive real `git` against
 * temp fixture repos and a scripted regression runner.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One merge candidate (deduped across the three queue sources). */
export interface QueueEntry {
  taskId: string;
  branch?: string;
}

/** Sonnet QC verdict evidence, read from state/task-updates/<ID>.qc.json. */
export interface QcEvidence {
  taskId?: string;
  phase?: string;
  commit?: string;
  checksRun?: string;
  defectsFound?: number;
  defectsFixed?: number;
  finalTestResult?: string;
  qcAgent?: string;
  queuedAt?: string;
  notes?: string;
  blockers?: unknown[];
}

export type AdmitRejection =
  | "NO_QC_PASS"
  | "QC_OPEN_DEFECTS"
  | "FAILING_TESTS"
  | "BLOCKERS_PRESENT"
  | "DEPENDENCIES_UNSATISFIED"
  | "BRANCH_MISSING"
  | "QC_COMMIT_NOT_ON_BRANCH"
  | "ALREADY_MERGED"
  | "EMPTY_TASK_ID";

export interface AdmissionDecision {
  taskId: string;
  branch: string;
  /** Commit the QC PASS was issued against (must be on the branch). */
  commit?: string;
  ok: boolean;
  /** Machine-readable rejection reason; undefined when ok. */
  reason?: AdmitRejection;
  detail?: string;
}

export interface MergeOutcome {
  taskId: string;
  branch: string;
  fromSha: string;
  mergeSha?: string;
  ok: boolean;
  /** CONFLICT → dispatched to conflict resolvers; never resolved here. */
  status: "MERGED" | "CONFLICT" | "SKIPPED";
  conflictFiles?: string[];
  detail?: string;
}

export interface RegressionResult {
  ok: boolean;
  output: string;
}

export interface RegressionRunner {
  run(affectedAreas: string[]): Promise<RegressionResult>;
}

export interface GitAdapter {
  /** Resolve a rev to a full sha; null when it does not resolve. */
  revParse(ref: string): Promise<string | null>;
  /** True when candidate is an ancestor of ref. */
  isAncestor(candidate: string, ref: string): Promise<boolean>;
  /**
   * Dry merge: `git merge-tree --write-tree branch ontoTip`. Clean →
   * treeSha set. Conflicted → treeSha set (partial) + conflicted paths.
   */
  mergeTree(branch: string, ontoTip: string): Promise<{
    clean: boolean;
    treeSha?: string;
    conflictFiles: string[];
  }>;
  /** Create a merge commit object from a tree + parents; returns the sha. */
  commitTree(opts: { treeSha: string; parents: string[]; message: string }): Promise<string>;
  /** CAS ref update: move refs/heads/<ref> to newSha only if at oldSha. */
  updateRef(ref: string, newSha: string, oldSha: string): Promise<void>;
  /** Changed paths oldSha..newSha with A/M/D/R status. */
  diffPaths(oldSha: string, newSha: string): Promise<
    Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>
  >;
  /** Byte size of a blob at `newSha:path`, or null when absent. */
  blobSize(newSha: string, filePath: string): Promise<number | null>;
  /** New blob content oldSha..newSha for scanning; concatenated text. */
  diffContent(oldSha: string, newSha: string): Promise<string>;
  /** Push ref to origin. */
  push(ref: string): Promise<void>;
  /** True when an origin remote exists. */
  hasOrigin(): Promise<boolean>;
}

export interface BatchMergeConfig {
  repoRoot: string;
  integrationBranch?: string;
  dryRun?: boolean;
  /** Push after a green regression (default true; dry-run forces false). */
  push?: boolean;
  /** Lock older than this is stale and gets broken (default 15 min). */
  lockStaleMs?: number;
  now?: () => Date;
  git?: GitAdapter;
  regression?: RegressionRunner;
}

export interface BatchMergeReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  integrationBranch: string;
  preBatchHead: string | null;
  postBatchHead: string | null;
  lockAcquired: boolean;
  lockError?: string;
  candidates: string[];
  rejected: Array<{ taskId: string; reason: string; detail?: string }>;
  ordered: string[];
  conflicts: Array<{ taskId: string; files: string[] }>;
  merged: MergeOutcome[];
  batchMergedSha: string | null;
  regression: { ok: boolean; output: string; affectedAreas: string[] } | null;
  reverted: boolean;
  culprits: string[];
  pushed: boolean;
  pushDetail?: string;
  queueAfter: string[];
  evidencePath?: string;
  ledgerLines: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Real git adapter
// ---------------------------------------------------------------------------

const GIT_AUTHOR_NAME = "MMCS Batch Merge";
const GIT_AUTHOR_EMAIL = "batch-merge@mmcs.local";

export class RealGitAdapter implements GitAdapter {
  constructor(
    private readonly repoRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.repoRoot, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // Attach the captured streams: rc=1 merge-tree carries the
            // partial tree + conflict entries in stdout and is handled by
            // the caller, not thrown away here.
            const e = err as Error & {
              code?: number | string;
              stdout?: string;
              stderr?: string;
            };
            e.stdout = stdout;
            e.stderr = stderr;
            e.message = `git ${args.join(" ")} failed (code=${String(e.code)}): ${String(stderr).trim()}`;
            reject(e);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  async revParse(ref: string): Promise<string | null> {
    try {
      const { stdout } = await this.git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      const sha = stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  async isAncestor(candidate: string, ref: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", candidate, ref]);
      return true;
    } catch {
      return false;
    }
  }

  async mergeTree(branch: string, ontoTip: string) {
    // rc=0 = clean merge, rc=1 = conflicts (stdout still carries the tree +
    // conflict entries). Both are expected; anything else is a real failure.
    let stdout: string;
    try {
      stdout = (
        await this.git(["merge-tree", "--write-tree", branch, ontoTip])
      ).stdout;
    } catch (err) {
      const e = err as Error & { code?: number | string; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== "string") {
        throw new Error(`merge-tree failed: ${e.message}`);
      }
      stdout = e.stdout;
    }
    const parsed = parseMergeTreeOutput(stdout);
    return {
      clean: parsed.conflictFiles.length === 0,
      treeSha: parsed.treeSha,
      conflictFiles: parsed.conflictFiles,
    };
  }

  async commitTree(opts: { treeSha: string; parents: string[]; message: string }) {
    const nowIso = this.now().toISOString();
    const args = [
      "commit-tree",
      opts.treeSha,
      ...opts.parents.flatMap((p) => ["-p", p]),
      "-m",
      opts.message,
    ];
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.repoRoot,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME,
            GIT_AUTHOR_EMAIL,
            GIT_COMMITTER_NAME: GIT_AUTHOR_NAME,
            GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
            GIT_AUTHOR_DATE: nowIso,
            GIT_COMMITTER_DATE: nowIso,
          },
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as Error & { code?: number | string };
            e.message = `commit-tree failed: ${String(stderr).trim()}`;
            reject(e);
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  async updateRef(ref: string, newSha: string, oldSha: string) {
    await this.git(["update-ref", `refs/heads/${ref}`, newSha, oldSha]);
  }

  async diffPaths(oldSha: string, newSha: string) {
    const { stdout } = await this.git(["diff", "--name-status", oldSha, newSha]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        const p = rest.join("\t");
        const s = (status ?? "").charAt(0).toUpperCase();
        const mapped: "added" | "modified" | "deleted" | "renamed" =
          s === "A" ? "added" : s === "D" ? "deleted" : s === "R" ? "renamed" : "modified";
        return { path: p, status: mapped };
      })
      .filter((f) => f.path.length > 0);
  }

  async blobSize(newSha: string, filePath: string) {
    try {
      const { stdout } = await this.git(["cat-file", "-s", `${newSha}:${filePath}`]);
      const n = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async diffContent(oldSha: string, newSha: string) {
    try {
      const { stdout } = await this.git(["diff", oldSha, newSha]);
      return stdout;
    } catch {
      return "";
    }
  }

  async push(ref: string) {
    await this.git(["push", "origin", ref]);
  }

  async hasOrigin() {
    try {
      const { stdout } = await this.git(["remote", "get-url", "origin"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}

/** Split `merge-tree --write-tree` stdout into tree sha + conflicted paths. */
function parseMergeTreeOutput(stdout: string): {
  treeSha?: string;
  conflictFiles: string[];
} {
  const lines = stdout.split("\n");
  const treeSha = lines[0]?.trim() || undefined;
  const conflictFiles: string[] = [];
  // Conflicted index entries list as "<mode> <sha> <stage>\t<path>" directly
  // after the tree sha; informational lines follow a blank line and include
  // "CONFLICT (<reason>): Merge conflict in <path>".
  for (const line of lines.slice(1)) {
    const idx = line.match(/^\d{6} [0-9a-f]{40} [123]\t(.+)$/);
    if (idx?.[1]) {
      conflictFiles.push(idx[1]);
      continue;
    }
    const info = line.match(/^CONFLICT \([^)]*\): .* in (.+)$/);
    if (info?.[1] && !conflictFiles.includes(info[1])) {
      conflictFiles.push(info[1]);
    }
  }
  return { treeSha, conflictFiles };
}

// ---------------------------------------------------------------------------
// Affected-area mapping (runbook §23: unit tests affected packages, typecheck,
// integration tests at affected boundaries — approximated by vitest area globs)
// ---------------------------------------------------------------------------

/** Map changed paths to the smallest testable areas. */
export function affectedAreas(paths: string[]): string[] {
  const areas = new Set<string>();
  for (const p of paths) {
    const pkg = /^packages\/([^/]+)\//.exec(p);
    if (pkg?.[1]) {
      areas.add(`packages/${pkg[1]}`);
      continue;
    }
    const app = /^apps\/([^/]+)\//.exec(p);
    if (app?.[1]) {
      areas.add(`apps/${app[1]}`);
      continue;
    }
    if (p.startsWith("scripts/")) {
      areas.add("scripts");
      continue;
    }
    if (
      p.startsWith("state/") ||
      p.startsWith("logs/") ||
      p.startsWith("docs/") ||
      p.endsWith(".md")
    ) {
      continue; // control planes and docs carry no executable area
    }
    areas.add("ALL");
  }
  if (areas.has("ALL")) return ["ALL"];
  return [...areas].sort();
}

export function vitestRegressionRunner(
  repoRoot: string,
  timeoutMs = 8 * 60 * 1000,
): RegressionRunner {
  return {
    run(areaList: string[]) {
      const globs = areaList.includes("ALL")
        ? []
        : areaList.map((a) => `${a}/**/*.{test,spec}.ts`);
      const args = globs.length > 0 ? ["vitest", "run", ...globs] : ["vitest", "run"];
      return new Promise<RegressionResult>((resolve) => {
        const child = execFile(
          "npx",
          args,
          { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const output = `${stdout}\n${stderr}`.trim();
            resolve({ ok: !err, output: output.slice(0, 16_000) });
          },
        );
        child.on("error", (e) => resolve({ ok: false, output: String(e) }));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Secret + heavy media scanning (admission rules 9/10, runbook §23)
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_+/-]{24,}["']/i,
];

const HEAVY_MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".wav",
  ".mp3",
  ".flac",
  ".m4a",
  ".aiff",
]);

export const HEAVY_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export interface ScanVerdict {
  /** Pattern descriptions — never the matched secret values themselves. */
  secrets: string[];
  heavyMedia: string[];
}

export function scanDiff(
  content: string,
  files: Array<{ path: string; status: string }>,
  sizeOf: (p: string) => number | null,
): ScanVerdict {
  const secrets: string[] = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) {
      // Record which pattern hit, never the value it matched.
      secrets.push(`pattern ${re.source.slice(0, 40)}`);
    }
  }
  const heavyMedia: string[] = [];
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    if (HEAVY_MEDIA_EXTENSIONS.has(ext)) {
      heavyMedia.push(f.path);
      continue;
    }
    const size = sizeOf(f.path);
    if (size !== null && size > HEAVY_MEDIA_MAX_BYTES) heavyMedia.push(f.path);
  }
  return { secrets, heavyMedia };
}

// ---------------------------------------------------------------------------
// Queue / QC / tasks reading
// ---------------------------------------------------------------------------

export async function readMergeQueue(
  filePath: string,
): Promise<QueueEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  let doc: { items?: unknown };
  try {
    doc = JSON.parse(raw) as { items?: unknown };
  } catch {
    return [];
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const out: QueueEntry[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim() !== "") {
      out.push({ taskId: item.trim() });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id =
        typeof o.taskId === "string" ? o.taskId : typeof o.id === "string" ? o.id : null;
      if (id && id.trim() !== "") {
        out.push({
          taskId: id.trim(),
          branch: typeof o.branch === "string" ? o.branch : undefined,
        });
      }
    }
  }
  return out;
}

/**
 * Parse the integration-queue.md table (control-file contract §4.1). Rows look
 * like `| IQ-002 | CORE-001 | branch | CORE | Sonnet | PASS | integration |
 * STATUS | sha |`. Tolerant of missing trailing cells.
 */
export async function readIntegrationQueueMd(
  filePath: string,
): Promise<Array<{ taskId: string; branch?: string; status?: string; landedSha?: string }>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: Array<{ taskId: string; branch?: string; status?: string; landedSha?: string }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is empty (leading pipe); need ≥ 9 cells with IQ id + task id.
    if (cells.length < 9) continue;
    const queueId = cells[1] ?? "";
    const taskId = cells[2] ?? "";
    if (!/^IQ-\d+$/.test(queueId) || taskId === "" || taskId === "Task ID") continue;
    rows.push({
      taskId,
      branch: cells[3] || undefined,
      status: cells[8] || undefined,
      landedSha: cells[9] || undefined,
    });
  }
  return rows;
}

export interface TaskRecord {
  id?: string;
  branch?: string;
  status?: string;
  dependsOn?: string[];
}

export async function readTasksJson(filePath: string): Promise<Map<string, TaskRecord>> {
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
    /* corrupt tasks.json — the engine still runs on queue + qc evidence */
  }
  return out;
}

export async function readQcEvidence(filePath: string): Promise<QcEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as QcEvidence;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmissionInput {
  entry: { taskId: string; branch?: string };
  qc: QcEvidence | null;
  task: TaskRecord | undefined;
  /** Tasks already recorded MERGED (integration-queue.md Landed column). */
  landed: Set<string>;
  /** Tasks whose qc.json says PASS or whose recorded status is PASS/MERGED. */
  satisfiedDeps: Set<string>;
  resolveRef: (ref: string) => Promise<string | null>;
  isAncestor: (candidate: string, ref: string) => Promise<boolean>;
  integrationBranch: string;
}

/**
 * Runbook §7.2 steps 3/4 + the mechanically checkable integration-queue.md
 * admission rules: QC PASS, zero open defects, tests green, no open blockers,
 * dependencies satisfied, branch resolvable, QC commit on branch. Secret and
 * media scans run later against the actual batch diff.
 */
export async function admitOne(input: AdmissionInput): Promise<AdmissionDecision> {
  const { entry, qc, task } = input;
  const taskId = entry.taskId.trim();
  const reject = (reason: AdmitRejection, detail: string): AdmissionDecision => ({
    taskId,
    branch: entry.branch ?? task?.branch ?? "",
    ok: false,
    reason,
    detail,
  });

  if (taskId === "") return reject("EMPTY_TASK_ID", "empty task id in queue");
  if (input.landed.has(taskId)) {
    return reject("ALREADY_MERGED", "already recorded as MERGED in integration-queue.md");
  }
  const branch = entry.branch ?? task?.branch;
  if (!branch || branch.trim() === "") {
    return reject("BRANCH_MISSING", "no branch recorded for task");
  }
  if (!qc) {
    return reject("NO_QC_PASS", `no state/task-updates/${taskId}.qc.json`);
  }
  if (qc.phase !== "PASS") {
    return reject("NO_QC_PASS", `qc phase is ${String(qc.phase)}`);
  }
  const defectsFound = typeof qc.defectsFound === "number" ? qc.defectsFound : 0;
  const defectsFixed = typeof qc.defectsFixed === "number" ? qc.defectsFixed : 0;
  if (defectsFound - defectsFixed > 0) {
    return reject("QC_OPEN_DEFECTS", `${defectsFound - defectsFixed} open defect(s)`);
  }
  if (qc.finalTestResult !== "PASS") {
    return reject("FAILING_TESTS", `qc finalTestResult is ${String(qc.finalTestResult)}`);
  }
  if (Array.isArray(qc.blockers) && qc.blockers.length > 0) {
    return reject("BLOCKERS_PRESENT", `${qc.blockers.length} open blocker(s)`);
  }
  for (const dep of Array.isArray(task?.dependsOn) ? task.dependsOn : []) {
    if (!input.satisfiedDeps.has(dep)) {
      return reject(
        "DEPENDENCIES_UNSATISFIED",
        `dependency ${dep} has no PASS/MERGED evidence`,
      );
    }
  }
  const branchTip = await input.resolveRef(branch);
  if (!branchTip) {
    return reject("BRANCH_MISSING", `branch ${branch} does not resolve`);
  }
  if (qc.commit && /^[0-9a-f]{7,40}$/.test(qc.commit)) {
    const onBranch = await input.isAncestor(qc.commit, branchTip);
    if (!onBranch) {
      return reject("QC_COMMIT_NOT_ON_BRANCH", `qc commit ${qc.commit} not on ${branch}`);
    }
  }
  return { taskId, branch, commit: qc.commit, ok: true };
}

// ---------------------------------------------------------------------------
// Ordering — dependency-first, then conflict risk, then stable id
// ---------------------------------------------------------------------------

/**
 * Kahn topological sort over `dependsOn`, restricted to mergeable ids. Ties
 * break by path-overlap count with other batch members (lower conflict risk
 * merges first), then task id for determinism. Non-DAG leftovers (cannot
 * happen in a real task graph) append in id order so nothing is dropped.
 */
export function orderBatch(
  ids: string[],
  depsOf: Map<string, string[]>,
  changedPathsByTask: Map<string, Set<string>>,
): string[] {
  const idSet = new Set(ids);
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    inDeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const dep of depsOf.get(id) ?? []) {
      if (!idSet.has(dep)) continue;
      inDeg.set(id, (inDeg.get(id) ?? 0) + 1);
      dependents.get(dep)?.push(id);
    }
  }
  const overlapCount = (id: string): number => {
    const own = changedPathsByTask.get(id);
    if (!own || own.size === 0) return 0;
    let n = 0;
    for (const other of ids) {
      if (other === id) continue;
      const theirs = changedPathsByTask.get(other);
      if (!theirs) continue;
      for (const p of own) if (theirs.has(p)) n += 1;
    }
    return n;
  };
  const byRisk = (a: string, b: string) =>
    overlapCount(a) - overlapCount(b) || a.localeCompare(b);
  const ready = ids.filter((id) => (inDeg.get(id) ?? 0) === 0).sort(byRisk);
  const out: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    out.push(id);
    for (const child of dependents.get(id) ?? []) {
      const d = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, d);
      if (d === 0) ready.push(child);
    }
    ready.sort(byRisk);
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

// ---------------------------------------------------------------------------
// Locking — state/locks/merge.lock (runbook §7.2 step 1)
// ---------------------------------------------------------------------------

export interface LockHandle {
  release(): Promise<void>;
}

export async function acquireMergeLock(
  repoRoot: string,
  opts: { staleMs?: number; now?: () => Date } = {},
): Promise<LockHandle> {
  const lockDir = path.join(repoRoot, "state", "locks");
  const lockPath = path.join(lockDir, "merge.lock");
  const staleMs = opts.staleMs ?? 15 * 60 * 1000;
  const now = opts.now ?? (() => new Date());
  await mkdir(lockDir, { recursive: true });
  const token = randomUUID();

  const tryCreate = async (): Promise<boolean> => {
    try {
      const handle = await open(lockPath, "wx");
      const payload = JSON.stringify({
        holder: "batch-merge",
        token,
        pid: process.pid,
        acquiredAt: now().toISOString(),
      });
      await handle.writeFile(payload);
      await handle.close();
      return true;
    } catch {
      return false;
    }
  };

  const breakIfStale = async (): Promise<void> => {
    try {
      const st = await stat(lockPath);
      if (now().getTime() - st.mtimeMs > staleMs) {
        await unlink(lockPath);
      }
    } catch {
      /* vanished already */
    }
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await tryCreate()) {
      return {
        release: async () => {
          // Only remove the lock when it is still ours (token match) — a
          // replacement lock held by a newer cycle must survive.
          try {
            const raw = await readFile(lockPath, "utf8");
            const doc = JSON.parse(raw) as { token?: string };
            if (doc.token === token) await unlink(lockPath);
          } catch {
            /* gone already */
          }
        },
      };
    }
    await breakIfStale();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`could not acquire ${lockPath} — another merge cycle holds it`);
}

// ---------------------------------------------------------------------------
// Small atomic writers (mirrors packages/core/src/recovery/atomic-write.ts;
// kept local so this script runs standalone of the packages)
// ---------------------------------------------------------------------------

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
    await rename(tmp, filePath);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
  }
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class BatchMergeEngine {
  private readonly repoRoot: string;
  private readonly integrationBranch: string;
  private readonly dryRun: boolean;
  private readonly pushEnabled: boolean;
  private readonly git: GitAdapter;
  private readonly regression: RegressionRunner;
  private readonly now: () => Date;
  private readonly lockStaleMs: number;

  constructor(config: BatchMergeConfig) {
    if (!config.repoRoot || config.repoRoot.trim() === "") {
      throw new Error("repoRoot is required");
    }
    this.repoRoot = config.repoRoot;
    this.integrationBranch = config.integrationBranch ?? "integration";
    this.dryRun = config.dryRun ?? false;
    this.pushEnabled = this.dryRun ? false : (config.push ?? true);
    this.git = config.git ?? new RealGitAdapter(this.repoRoot, config.now ?? (() => new Date()));
    this.regression = config.regression ?? vitestRegressionRunner(this.repoRoot);
    this.now = config.now ?? (() => new Date());
    this.lockStaleMs = config.lockStaleMs ?? 15 * 60 * 1000;
  }

  async run(): Promise<BatchMergeReport> {
    const startedAt = this.now().toISOString();
    const report: BatchMergeReport = {
      startedAt,
      finishedAt: startedAt,
      dryRun: this.dryRun,
      integrationBranch: this.integrationBranch,
      preBatchHead: null,
      postBatchHead: null,
      lockAcquired: false,
      candidates: [],
      rejected: [],
      ordered: [],
      conflicts: [],
      merged: [],
      batchMergedSha: null,
      regression: null,
      reverted: false,
      culprits: [],
      pushed: false,
      queueAfter: [],
      ledgerLines: [],
      notes: [],
    };

    // 1. lock
    let lock: LockHandle;
    try {
      lock = await acquireMergeLock(this.repoRoot, {
        staleMs: this.lockStaleMs,
        now: this.now,
      });
      report.lockAcquired = true;
    } catch (err) {
      report.lockError = String((err as Error).message);
      report.finishedAt = this.now().toISOString();
      return report;
    }

    try {
      await this.cycle(report);
    } finally {
      await lock.release();
    }

    report.finishedAt = this.now().toISOString();
    return report;
  }

  private async cycle(report: BatchMergeReport): Promise<void> {
    // 2. read queue sources
    const queueJson = await readMergeQueue(
      path.join(this.repoRoot, "state", "merge-queue.json"),
    );
    const queueMd = await readIntegrationQueueMd(
      path.join(this.repoRoot, "integration-queue.md"),
    );
    const tasks = await readTasksJson(path.join(this.repoRoot, "state", "tasks.json"));

    // Tasks already landed (integration-queue.md Status column).
    const landed = new Set<string>();
    for (const row of queueMd) {
      if ((row.status ?? "") === "MERGED") landed.add(row.taskId);
    }
    for (const [id, t] of tasks) {
      const st = t.status ?? "";
      if (st === "MERGED") landed.add(id);
    }

    // Dependencies satisfied by PASS/MERGED evidence: tasks.json status, the
    // landed set, or a PASS qc verdict file for the dependency itself.
    const satisfiedDeps = new Set<string>(landed);
    for (const [id, t] of tasks) {
      const st = t.status ?? "";
      if (st === "PASS" || st === "QC_PASS" || st === "MERGED") satisfiedDeps.add(id);
    }
    for (const entry of [...queueJson, ...queueMd]) {
      const qc = await readQcEvidence(
        path.join(this.repoRoot, "state", "task-updates", `${entry.taskId}.qc.json`),
      );
      if (qc?.phase === "PASS") satisfiedDeps.add(entry.taskId);
    }

    // Dedupe candidates: merge-queue.json wins, then queue md, then tasks.json.
    // Already-landed rows are skipped outright — re-admitting them every cycle
    // would spam the report with ALREADY_MERGED noise.
    const byId = new Map<string, QueueEntry>();
    for (const q of [...queueJson, ...queueMd]) {
      if (landed.has(q.taskId) || byId.has(q.taskId)) continue;
      byId.set(q.taskId, q);
    }
    for (const [id, t] of tasks) {
      const st = t.status ?? "";
      if ((st === "PASS" || st === "QC_PASS") && !byId.has(id)) {
        byId.set(id, { taskId: id, branch: t.branch });
      }
    }
    const candidates = [...byId.values()];
    report.candidates = candidates.map((c) => c.taskId);

    // 3./4. admission
    const admitted: AdmissionDecision[] = [];
    const depsOf = new Map<string, string[]>();
    for (const entry of candidates) {
      const qc = await readQcEvidence(
        path.join(this.repoRoot, "state", "task-updates", `${entry.taskId}.qc.json`),
      );
      const decision = await admitOne({
        entry,
        qc,
        task: tasks.get(entry.taskId),
        landed,
        satisfiedDeps,
        resolveRef: (ref) => this.git.revParse(ref),
        isAncestor: (cand, ref) => this.git.isAncestor(cand, ref),
        integrationBranch: this.integrationBranch,
      });
      if (decision.ok) {
        admitted.push(decision);
        depsOf.set(entry.taskId, tasks.get(entry.taskId)?.dependsOn ?? []);
      } else {
        report.rejected.push({
          taskId: decision.taskId,
          reason: decision.reason ?? "UNKNOWN",
          detail: decision.detail,
        });
      }
    }

    const preBatchHead = await this.git.revParse(this.integrationBranch);
    report.preBatchHead = preBatchHead;
    if (!preBatchHead) {
      report.notes.push(
        `integration branch ${this.integrationBranch} not found; cycle skipped`,
      );
      report.finishedAt = this.now().toISOString();
      return;
    }

    // 5./6. conflict pre-check per item against the current integration tip;
    // collect changed-path sets for risk ordering.
    const changedPathsByTask = new Map<string, Set<string>>();
    const mergeable: AdmissionDecision[] = [];
    for (const item of admitted) {
      const tip = (await this.git.revParse(this.integrationBranch)) ?? preBatchHead;
      if (!tip) continue;
      const mt = await this.git.mergeTree(item.branch, tip);
      if (!mt.clean) {
        report.conflicts.push({ taskId: item.taskId, files: mt.conflictFiles });
        report.merged.push({
          taskId: item.taskId,
          branch: item.branch,
          fromSha: (await this.git.revParse(item.branch)) ?? "",
          ok: false,
          status: "CONFLICT",
          conflictFiles: mt.conflictFiles,
          detail: "conflict — dispatched to dedicated merge workflow resolvers",
        });
        continue;
      }
      mergeable.push(item);
      const files = await this.git.diffPaths(tip, (await this.git.revParse(item.branch)) ?? tip);
      changedPathsByTask.set(item.taskId, new Set(files.map((f) => f.path)));
    }
    if (report.conflicts.length > 0) {
      report.notes.push(
        `${report.conflicts.length} conflict-blocked item(s) left for the dedicated merge workflow resolvers`,
      );
    }

    report.ordered = orderBatch(mergeable.map((m) => m.taskId), depsOf, changedPathsByTask);

    if (this.dryRun) {
      report.notes.push("dry-run: no refs, files, or pushes were mutated");
      const mergedIds = new Set(
        report.merged.filter((m) => m.status === "MERGED").map((m) => m.taskId),
      );
      report.queueAfter = report.candidates.filter((id) => !mergedIds.has(id));
      return;
    }

    if (report.ordered.length === 0) {
      report.notes.push("nothing to merge this cycle");
      await this.writeEvidenceAndLedger(report);
      return;
    }

    // 7. merge the batch — CAS against the head we planned from each time.
    let integrationHead = preBatchHead;
    const outcomes: MergeOutcome[] = [];
    let batchAborted = false;
    for (const taskId of report.ordered) {
      const item = mergeable.find((m) => m.taskId === taskId);
      if (!item) continue;
      const fromSha = (await this.git.revParse(item.branch)) ?? "";
      const currentTip = await this.git.revParse(this.integrationBranch);
      if (!currentTip || currentTip !== integrationHead) {
        outcomes.push({
          taskId,
          branch: item.branch,
          fromSha,
          ok: false,
          status: "SKIPPED",
          detail: "integration tip moved mid-cycle; batch stopped before any damage",
        });
        const outcome0 = outcomes[outcomes.length - 1];
        if (outcome0) report.merged.push(outcome0);
        batchAborted = true;
        break;
      }
      const mt = await this.git.mergeTree(item.branch, currentTip);
      if (!mt.clean || !mt.treeSha) {
        report.conflicts.push({ taskId, files: mt.conflictFiles });
        outcomes.push({
          taskId,
          branch: item.branch,
          fromSha,
          ok: false,
          status: "CONFLICT",
          conflictFiles: mt.conflictFiles,
          detail: "conflict surfaced during batch — skipped; resolvers handle it",
        });
        const outcome1 = outcomes[outcomes.length - 1];
        if (outcome1) report.merged.push(outcome1);
        continue;
      }
      const qc = await readQcEvidence(
        path.join(this.repoRoot, "state", "task-updates", `${taskId}.qc.json`),
      );
      const mergeSha = await this.git.commitTree({
        treeSha: mt.treeSha,
        parents: [currentTip, fromSha],
        message: `merge: ${taskId}\n\nSonnet QC PASS (agent: ${qc?.qcAgent ?? "unknown"}); tests ${String(qc?.finalTestResult ?? "unknown")}`,
      });
      await this.git.updateRef(this.integrationBranch, mergeSha, currentTip);
      integrationHead = mergeSha;
      outcomes.push({
        taskId,
        branch: item.branch,
        fromSha,
        mergeSha,
        ok: true,
        status: "MERGED",
      });
      const outcome2 = outcomes[outcomes.length - 1];
      if (outcome2) report.merged.push(outcome2);
    }
    const realMerged = outcomes.filter((o) => o.status === "MERGED");
    report.batchMergedSha = realMerged.length > 0 ? integrationHead : null;
    report.postBatchHead = integrationHead;

    if (realMerged.length === 0) {
      report.notes.push(
        batchAborted
          ? "batch aborted before any merge; integration untouched"
          : "no merge commits created this cycle",
      );
      await this.writeEvidenceAndLedger(report);
      return;
    }

    // 9. affected-area regression over the whole batch diff.
    const batchDiff = await this.git.diffPaths(
      preBatchHead ?? integrationHead,
      integrationHead,
    );
    const areas = affectedAreas(batchDiff.map((f) => f.path));
    const reg = await this.regression.run(areas);
    report.regression = { ok: reg.ok, output: reg.output, affectedAreas: areas };

    if (!reg.ok) {
      // 10. revert the whole batch, then isolate culprits item-by-item.
      if (preBatchHead) {
        await this.git.updateRef(this.integrationBranch, preBatchHead, integrationHead);
        report.reverted = true;
        report.postBatchHead = preBatchHead;
      }
      const culprits: string[] = [];
      const base = preBatchHead ?? integrationHead;
      for (const o of realMerged) {
        const single = await this.git.mergeTree(o.branch, base);
        if (!single.clean || !single.treeSha) continue;
        const mSha = await this.git.commitTree({
          treeSha: single.treeSha,
          parents: [base, o.fromSha],
          message: `merge: ${o.taskId} (culprit isolation)`,
        });
        await this.git.updateRef(this.integrationBranch, mSha, base);
        const singleReg = await this.regression.run(areas);
        await this.git.updateRef(this.integrationBranch, base, mSha);
        if (!singleReg.ok) culprits.push(o.taskId);
      }
      report.culprits = culprits;
      report.notes.push(
        `regression failed; batch reverted; culprits: ${culprits.join(", ") || "none isolated"}`,
      );
      await this.writeEvidenceAndLedger(report);
      return;
    }

    // 11. push only after green regression + a clean secret/heavy-media scan.
    let scanClean = true;
    if (this.pushEnabled) {
      const sizes = new Map<string, number | null>();
      for (const f of batchDiff) {
        sizes.set(f.path, await this.git.blobSize(integrationHead, f.path));
      }
      const scan = scanDiff(
        await this.git.diffContent(preBatchHead ?? integrationHead, integrationHead),
        batchDiff,
        (p) => sizes.get(p) ?? null,
      );
      if (scan.secrets.length > 0 || scan.heavyMedia.length > 0) {
        scanClean = false;
        if (preBatchHead) {
          await this.git.updateRef(this.integrationBranch, preBatchHead, integrationHead);
          report.reverted = true;
          report.postBatchHead = preBatchHead;
        }
        report.notes.push(
          `pre-push scan failed (${scan.secrets.length} secret pattern(s), ${scan.heavyMedia.length} heavy media file(s)); batch reverted — never pushed`,
        );
        await this.writeEvidenceAndLedger(report);
        return;
      }
    }
    if (scanClean && this.pushEnabled && (await this.git.hasOrigin())) {
      try {
        await this.git.push(this.integrationBranch);
        report.pushed = true;
      } catch (err) {
        report.pushDetail = String((err as Error).message);
        report.notes.push("push failed — integration stays local; retry next cycle");
      }
    } else {
      report.pushDetail = this.pushEnabled ? "no origin remote" : "push disabled";
    }

    // 12./13./14. control state + queue + evidence.
    await this.markMergedAndDrainQueue(report, realMerged);
    await this.writeEvidenceAndLedger(report);
  }

  /** 12./13. mark MERGED in tasks.json + drain queue documents + checkpoint. */
  private async markMergedAndDrainQueue(
    report: BatchMergeReport,
    merged: MergeOutcome[],
  ): Promise<void> {
    const shaByTask = new Map(merged.map((m) => [m.taskId, m.mergeSha ?? ""]));

    const tasksPath = path.join(this.repoRoot, "state", "tasks.json");
    const tasksRaw = await readTextOrNull(tasksPath);
    if (tasksRaw) {
      try {
        const doc = JSON.parse(tasksRaw) as { items?: Array<TaskRecord> };
        for (const t of Array.isArray(doc.items) ? doc.items : []) {
          if (typeof t?.id === "string" && shaByTask.has(t.id)) {
            t.status = "MERGED";
          }
        }
        await atomicWriteFile(tasksPath, `${JSON.stringify(doc, null, 2)}\n`);
      } catch {
        report.notes.push("tasks.json update skipped (unreadable)");
      }
    }

    // merge-queue.json — remove merged ids.
    const mqPath = path.join(this.repoRoot, "state", "merge-queue.json");
    const mqRaw = await readTextOrNull(mqPath);
    if (mqRaw) {
      try {
        const doc = JSON.parse(mqRaw) as { items?: unknown[] };
        const kept = (doc.items ?? []).filter((item) => {
          const id =
            typeof item === "string"
              ? item
              : item && typeof item === "object"
                ? String(
                    (item as Record<string, unknown>).taskId ??
                      (item as Record<string, unknown>).id ??
                      "",
                  )
                : "";
          return !shaByTask.has(id);
        });
        await atomicWriteFile(
          mqPath,
          `${JSON.stringify({ ...doc, items: kept, updated_at: this.now().toISOString() }, null, 2)}\n`,
        );
      } catch {
        report.notes.push("merge-queue.json update skipped (unreadable)");
      }
    }
    report.queueAfter = report.candidates.filter((id) => !shaByTask.has(id));

    // integration-queue.md — set Status MERGED + Landed SHA per merged row.
    const iqPath = path.join(this.repoRoot, "integration-queue.md");
    const iqRaw = await readTextOrNull(iqPath);
    if (iqRaw) {
      const lines = iqRaw.split("\n").map((line) => {
        if (!line.trim().startsWith("|")) return line;
        const cells = line.split("|");
        if (cells.length < 10) return line;
        const taskId = (cells[2] ?? "").trim();
        if (!shaByTask.has(taskId)) return line;
        cells[8] = " MERGED ";
        cells[9] = ` ${shaByTask.get(taskId) || "Pending"} `;
        return cells.join("|");
      });
      await atomicWriteFile(iqPath, `${lines.join("\n")}`);
    }

    // checkpoint heartbeat — best effort, never fails the cycle.
    const cpPath = path.join(this.repoRoot, "state", "checkpoint.json");
    const cpRaw = await readTextOrNull(cpPath);
    if (cpRaw) {
      try {
        const doc = JSON.parse(cpRaw) as Record<string, unknown>;
        doc.lastMergeAt = this.now().toISOString();
        if (report.batchMergedSha) {
          doc.lastKnownGoodCommit = report.batchMergedSha;
          doc.current_integration_sha = report.batchMergedSha;
        }
        await atomicWriteFile(cpPath, `${JSON.stringify(doc, null, 2)}\n`);
      } catch {
        report.notes.push("checkpoint heartbeat skipped (unreadable)");
      }
    }
  }

  /** 14. evidence log + ledger append (never in dry-run). */
  private async writeEvidenceAndLedger(report: BatchMergeReport): Promise<void> {
    if (this.dryRun) return;
    const evidencePath = path.join(
      this.repoRoot,
      "logs",
      "merges",
      `${this.now().toISOString().replace(/[:.]/g, "-")}-batch-merge.json`,
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await atomicWriteFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
    report.evidencePath = evidencePath;

    const lines: string[] = [];
    for (const m of report.merged) {
      lines.push(
        `${this.now().toISOString()} | ${m.taskId} | batch-merge | ${m.status} | ${m.detail ?? m.mergeSha ?? ""}`,
      );
    }
    if (report.regression) {
      lines.push(
        `${this.now().toISOString()} | BATCH-MERGE | batch-merge | REGRESSION | ${report.regression.ok ? "PASS" : "FAIL"} areas=${report.regression.affectedAreas.join(",") || "none"}`,
      );
    }
    if (lines.length > 0) {
      try {
        await appendFile(path.join(this.repoRoot, "ledger.md"), `${lines.join("\n")}\n`);
        report.ledgerLines = lines;
      } catch {
        /* ledger is best-effort; evidence file is the durable record */
      }
    }
  }
}

export function isMainEntry(moduleUrl: string): boolean {
  try {
    return import.meta.url === pathToFileURL(moduleUrl).href;
  } catch {
    return false;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root when this file sits at scripts/orchestration/batch-merge.ts. */
export const DEFAULT_REPO_ROOT = path.resolve(HERE, "..", "..");