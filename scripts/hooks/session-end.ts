/// <reference types="node" />
import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { uniqueIds } from "../../packages/core/src/recovery/index.js";
import { CheckpointWiring, withCheckpointLock } from "../orchestration/checkpoint.js";

/**
 * REC-005 — SessionEnd hook (runbook §6 "SessionEnd"; todo.md TASK-REC-005;
 * spec §28 checkpoint cadence "session end"; spec §28 "Recovery after
 * restart").
 *
 * Final checkpoint + exact resume state. Claude Code runs this when the
 * session ends. Contract:
 *
 * 1. read the hook JSON from stdin (tolerant: empty/unparseable stdin must
 *    never stop the save — the save matters more than the payload);
 * 2. take the cross-process checkpoint lock (`state/locks/checkpoint.lock`,
 *    same protocol as REC-001/REC-002) so a watchdog cycle / merge loop
 *    cannot interleave with the flush;
 * 3. update `state/checkpoint.json` atomically (temp + fsync + rename via
 *    CheckpointWiring "session-end" cadence write) stamping
 *    `lastCheckpointAt` and machine `nextActions` that carry the exact
 *    resume command;
 * 4. update `recovery.md` with an idempotent, marker-delimited
 *    "Last Session End" block holding the EXACT resume command and state
 *    (runbook §26) — recovery.md is first in the §5.2 resume read order, so
 *    a fresh session sees the resume instructions before anything else;
 * 5. append a `SESSION_END_CHECKPOINT` line to `ledger.md` (append-only);
 * 6. exit 0 after the flush. On flush failure exit 2 with stderr detail —
 *    SessionEnd cannot prevent the session from ending, but the failure is
 *    surfaced so the next session knows the checkpoint may be stale.
 *
 * Entry point chain: `.claude/hooks/session-end.sh` (executable, registered
 * in `.claude/settings.json`) → this module via tsx. Repo root resolution:
 * `--repo-root` flag, then `MMCS_REPO_ROOT`, then cwd.
 */

export const SESSION_END_NEXT_ACTION = "resume-from-session-end-checkpoint";
export const LEDGER_TAG = "SESSION_END_CHECKPOINT";
export const RESUME_COMMAND = "claude";

const RECOVERY_START = "<!-- MMCS:SESSION-END:START -->";
const RECOVERY_END = "<!-- MMCS:SESSION-END:END -->";

/** Hook JSON payload Claude Code pipes to SessionEnd hooks (runbook §6). */
export interface SessionEndHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  reason?: unknown;
}

export interface SessionEndResult {
  ok: true;
  repoRoot: string;
  reason: string;
  lastCheckpointAt: string;
  recoveryUpdated: boolean;
  ledgerAppended: boolean;
  /** Exact resume state recorded in recovery.md (runbook §26). */
  resume: {
    integrationSha: string | null;
    mainSha: string | null;
    lastKnownGoodCommit: string | null;
    buildComplete: boolean;
    activeTaskIds: string[];
    nextActions: string[];
  };
}

/** Coerce the loose hook payload into the strings we record. The payload
 * arrives over stdin and is not trusted: whitespace runs (incl. newlines and
 * carriage returns) are collapsed to single spaces so a hostile `reason` or
 * `session_id` can never forge an extra ledger.md row or break out of the
 * single-line recovery.md format inside the marker block. */
export function normalizeInput(raw: unknown): { reason: string; sessionId: string } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as SessionEndHookInput;
  const str = (v: unknown): string =>
    typeof v === "string" && v.trim() !== "" ? v.trim().replace(/\s+/g, " ") : "";
  return {
    reason: str(obj.reason) || "unknown",
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
        resolve(null); // tolerated: save proceeds, payload ignored
      }
    });
    stream.on("error", () => resolve(null));
  });
}

/** Best-effort HEAD SHA read; never throws (a failed git read is not a
 * reason to lose the checkpoint — recovery re-derives SHAs from git). */
async function gitRevParse(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["rev-parse", ref], {
      cwd: repoRoot,
      timeout: 5_000,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Marker-delimited recovery.md block: replaced in place on every session end
 * so the file never accumulates one block per session. Holds the EXACT
 * resume command and state a fresh session must follow (runbook §26).
 */
export function buildRecoveryBlock(state: {
  savedAt: string;
  lastCheckpointAt: string;
  reason: string;
  sessionId: string;
  resume: SessionEndResult["resume"];
  repoRoot: string;
}): string {
  const shaLine = (label: string, sha: string | null): string =>
    `- **${label}:** ${sha ? `\`${sha}\`` : "(derive with `git rev-parse <ref>` — not read at session end)"}`;
  const lines = [
    RECOVERY_START,
    "### Last Session End (auto — REC-005)",
    "",
    `- **Saved at:** ${state.savedAt}`,
    `- **End reason:** ${state.reason}`,
    `- **Session:** ${state.sessionId || "-"}`,
    `- **Checkpoint:** state/checkpoint.json (lastCheckpointAt ${state.lastCheckpointAt})`,
    shaLine("Integration HEAD", state.resume.integrationSha),
    shaLine("Main HEAD", state.resume.mainSha),
    shaLine("Last known good", state.resume.lastKnownGoodCommit),
    `- **buildComplete:** ${state.resume.buildComplete ? "true — loops stay stopped" : "false — restart the two 10-minute loops (\`/loop 10m /mmcs-watchdog\`, \`/loop 10m /mmcs-batch-merge\`)"}`,
    `- **Active tasks:** ${state.resume.activeTaskIds.length ? state.resume.activeTaskIds.join(", ") : "(none)"}`,
    `- **Next actions:** ${state.resume.nextActions.length ? state.resume.nextActions.join(" · ") : "(none recorded)"}`,
    `- **EXACT RESUME COMMAND:** \`cd ${state.repoRoot} && ${RESUME_COMMAND}\` — then follow §1 Resume Read Order (recovery.md → state/checkpoint.json → build-status.md → todo.md). Never recreate ACTIVE/PASS/MERGED tasks; reconcile worktrees/branches vs recorded state first.`,
    RECOVERY_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the marker block; falls back to append. */
export function upsertRecoveryBlock(existing: string, block: string): string {
  const start = existing.indexOf(RECOVERY_START);
  const end = existing.indexOf(RECOVERY_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + RECOVERY_END.length);
  }
  const lines = existing.split("\n");
  const hr = lines.findIndex((line) => line.trim() === "---");
  if (hr !== -1) {
    lines.splice(hr + 1, 0, "", block);
    return lines.join("\n");
  }
  const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  return existing + suffix + "\n" + block + "\n";
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface RunSessionEndOptions {
  repoRoot: string;
  input?: unknown;
  lockOptions?: { timeoutMs?: number; staleMs?: number };
  now?: () => string;
}

/**
 * The full flush: checkpoint lock → checkpoint.json → recovery.md → ledger.
 * Everything inside one critical section so a concurrent flush/merge loop
 * cannot observe a half-updated resume state.
 */
export async function runSessionEnd(opts: RunSessionEndOptions): Promise<SessionEndResult> {
  const repoRoot = opts.repoRoot;
  if (!repoRoot || repoRoot.trim() === "") {
    throw new Error("repoRoot is required");
  }
  const { reason, sessionId } = normalizeInput(opts.input);
  const now = opts.now ?? nowIso;

  const wiring = new CheckpointWiring(repoRoot);
  let lastCheckpointAt = "";
  let recoveryUpdated = false;
  let ledgerAppended = false;
  let resume: SessionEndResult["resume"] = {
    integrationSha: null,
    mainSha: null,
    lastKnownGoodCommit: null,
    buildComplete: false,
    activeTaskIds: [],
    nextActions: [],
  };

  await withCheckpointLock(
    repoRoot,
    async () => {
      // 1. checkpoint.json — atomic "session-end" cadence write under the
      // lock (cache invalidated first: another process may have written).
      // Written through `wiring.service.update` directly — the wiring layer's
      // own cadence methods take the same lock we already hold here, so going
      // through them would self-deadlock (REC-002 uses the identical shape).
      wiring.service.invalidate();
      // SHAs are read OUTSIDE CheckpointWiring (inside our lock) because the
      // wiring layer is deliberately free of child-process calls; a failed
      // read stays null and recovery re-derives from git.
      const [integrationSha, mainSha] = await Promise.all([
        gitRevParse(repoRoot, "refs/heads/integration"),
        gitRevParse(repoRoot, "refs/heads/main"),
      ]);
      const state = await wiring.service.update((draft) => {
        draft.nextActions = uniqueIds([
          SESSION_END_NEXT_ACTION,
          `resume-command: cd ${repoRoot} && ${RESUME_COMMAND}`,
        ]);
      });
      lastCheckpointAt = state.lastCheckpointAt;
      resume = {
        integrationSha,
        mainSha,
        lastKnownGoodCommit: state.lastKnownGoodCommit,
        buildComplete: state.buildComplete,
        activeTaskIds: state.activeTaskIds,
        nextActions: state.nextActions,
      };

      // 2. recovery.md — idempotent marker block with the exact resume state.
      const recoveryPath = join(repoRoot, "recovery.md");
      let existing = "";
      try {
        existing = await readFile(recoveryPath, "utf8");
      } catch {
        existing = "# Crash Recovery & Session Resume Protocol (recovery.md)\n";
      }
      const block = buildRecoveryBlock({
        savedAt: now(),
        lastCheckpointAt,
        reason,
        sessionId,
        resume,
        repoRoot,
      });
      const next = upsertRecoveryBlock(existing, block);
      if (next !== existing) {
        await atomicWriteText(recoveryPath, next);
      }
      recoveryUpdated = true;

      // 3. ledger.md — append-only SESSION_END_CHECKPOINT line.
      const ledgerPath = join(repoRoot, "ledger.md");
      const note = `reason=${reason}; checkpoint=state/checkpoint.json @ ${lastCheckpointAt}; integration=${resume.integrationSha ?? "-"}; session=${sessionId || "-"}`;
      await mkdir(dirname(ledgerPath), { recursive: true });
      await appendFile(ledgerPath, `| ${now()} | REC-005 | session-end-hook | ${LEDGER_TAG} | ${note} |\n`);
      ledgerAppended = true;
    },
    opts.lockOptions,
  );

  return { ok: true, repoRoot, reason, lastCheckpointAt, recoveryUpdated, ledgerAppended, resume };
}

/** Atomic text write (temp + fsync + rename) for recovery.md — the same
 * durability protocol as the checkpoint service: rename must not become
 * visible to a later reader before the bytes are on disk, or a crash between
 * the two leaves an empty/truncated recovery.md, which is precisely the file
 * a crashed session depends on. */
async function atomicWriteText(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI — invoked by .claude/hooks/session-end.sh. Exit 0 after a successful
// flush; exit 2 when the flush failed (the failure is surfaced so the next
// session knows the checkpoint may be stale — SessionEnd cannot stop the
// session from ending).
// ---------------------------------------------------------------------------

export interface HookCliOptions {
  repoRoot?: string;
  reason?: string;
  help?: boolean;
  selftest?: boolean;
}

const USAGE = `Usage: npx tsx scripts/hooks/session-end.ts [options]  < hook.json

SessionEnd hook (REC-005): final checkpoint + exact resume state. Reads the
Claude Code hook JSON from stdin, then flushes checkpoint.json (session-end
cadence write) + the recovery.md "Last Session End" block (exact resume
command/state, runbook §26) + a SESSION_END_CHECKPOINT ledger line under the
checkpoint lock.

Options:
  --repo-root <path>   Repo root (default: $MMCS_REPO_ROOT, else cwd)
  --reason <name>      Override end reason when stdin has none
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
      case "--reason":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.reason = argv[i];
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
 * Simulated hook invocation used by --selftest and the vitest suite: pipes a
 * realistic SessionEnd payload through the full flush against a temp repo
 * root and verifies all three artifacts plus the exact resume command.
 */
export async function selftest(log: (line: string) => void = () => undefined): Promise<void> {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mmcs-sessionend-selftest-"));
  try {
    const payload = {
      session_id: "selftest-session",
      hook_event_name: "SessionEnd",
      reason: "clear",
    };
    const result = await runSessionEnd({ repoRoot: dir, input: payload });
    const checkpoint = JSON.parse(
      await readFile(join(dir, "state", "checkpoint.json"), "utf8"),
    ) as { lastCheckpointAt?: string; nextActions?: string[] };
    if (checkpoint.lastCheckpointAt !== result.lastCheckpointAt) {
      throw new Error("checkpoint lastCheckpointAt not stamped");
    }
    if (!checkpoint.nextActions?.includes(SESSION_END_NEXT_ACTION)) {
      throw new Error("checkpoint nextActions missing resume hint");
    }
    if (!checkpoint.nextActions.some((a) => a.startsWith("resume-command: "))) {
      throw new Error("checkpoint nextActions missing exact resume command");
    }
    const recovery = await readFile(join(dir, "recovery.md"), "utf8");
    if (!recovery.includes(RECOVERY_START) || !recovery.includes("EXACT RESUME COMMAND")) {
      throw new Error("recovery.md block missing");
    }
    if (!recovery.includes("**End reason:** clear")) {
      throw new Error("recovery.md end reason missing");
    }
    const ledger = await readFile(join(dir, "ledger.md"), "utf8");
    if (!ledger.includes(LEDGER_TAG)) {
      throw new Error(`ledger ${LEDGER_TAG} line missing`);
    }
    // Idempotent second flush: one marker block, ledger grows by one line.
    const ledgerLinesBefore = ledger.trimEnd().split("\n").length;
    await runSessionEnd({ repoRoot: dir, input: payload });
    const recovery2 = await readFile(join(dir, "recovery.md"), "utf8");
    if (recovery2.split(RECOVERY_START).length - 1 !== 1) {
      throw new Error("recovery.md accumulated duplicate blocks");
    }
    const ledger2 = await readFile(join(dir, "ledger.md"), "utf8");
    if (ledger2.trimEnd().split("\n").length !== ledgerLinesBefore + 1) {
      throw new Error("ledger did not append exactly one line per flush");
    }
    log("session-end selftest: checkpoint + recovery + ledger verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log("SESSION-END SELFTEST PASS");
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
    io.stderr(`session-end hook: ${(err as Error).message}\n\n${USAGE}`);
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
    const input =
      opts.reason && rawInput && typeof rawInput === "object"
        ? { ...(rawInput as object), reason: opts.reason }
        : opts.reason
          ? { reason: opts.reason }
          : rawInput;
    const result = await runSessionEnd({ repoRoot, input });
    io.stdout(
      `session-end flush ok: reason=${result.reason} checkpoint=${result.lastCheckpointAt} ` +
        `recovery.md=${result.recoveryUpdated ? "updated" : "unchanged"} ledger=${LEDGER_TAG} appended ` +
        `resume-command=cd ${result.repoRoot} && ${RESUME_COMMAND}\n`,
    );
    return 0;
  } catch (err) {
    // Fail loudly: the session still ends, but the next session must know the
    // final checkpoint may be missing/stale. Claude Code surfaces stderr on
    // exit 2.
    io.stderr(`session-end hook flush FAILED — final checkpoint may be stale; run scripts/hooks/session-end.ts --selftest and follow runbook §26 manually: ${(err as Error).message}\n`);
    return 2;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runHook(process.argv.slice(2));
}

// Run only when THIS module is the entry program (hook script / selftest),
// never on import from tests. Same guard pattern as REC-001/REC-002 CLIs.
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
