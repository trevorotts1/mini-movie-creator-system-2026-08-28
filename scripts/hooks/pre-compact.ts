/// <reference types="node" />
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { uniqueIds } from "../../packages/core/src/recovery/index.js";
import { CheckpointWiring, withCheckpointLock } from "../orchestration/checkpoint.js";

/**
 * REC-002 — PreCompact hook (runbook §6 "PreCompact"; todo.md TASK-REC-002;
 * spec §28/§32 resume-after-compaction).
 *
 * Save-first, compact-second. Claude Code runs this before any compaction
 * (manual /compact or auto). Contract:
 *
 * 1. read the hook JSON from stdin (tolerant: empty/unparseable stdin must
 *    never stop the save — the save matters more than the payload);
 * 2. take the cross-process checkpoint lock (`state/locks/checkpoint.lock`,
 *    same protocol as REC-001) so a watchdog cycle / merge loop cannot
 *    interleave with the flush;
 * 3. update `state/checkpoint.json` atomically (temp + fsync + rename via
 *    CheckpointService) stamping `lastCheckpointAt` and machine
 *    `nextActions`;
 * 4. update `session.md` with an idempotent, marker-delimited PreCompact
 *    checkpoint block (the human resume page, runbook §4 contract);
 * 5. append a `PRECOMPACT_CHECKPOINT` line to `ledger.md` (append-only);
 * 6. exit 0 after the flush. On flush failure exit 2 with stderr detail —
 *    compaction must not proceed over a lost save (fail closed).
 *
 * Entry point chain: `.claude/hooks/pre-compact.sh` (executable, registered
 * in `.claude/settings.json`) → this module via tsx. Repo root resolution:
 * `--repo-root` flag, then `MMCS_REPO_ROOT`, then cwd.
 */

export const PRECOMPACT_NEXT_ACTION = "resume-from-precompact-checkpoint";
export const LEDGER_TAG = "PRECOMPACT_CHECKPOINT";

const SESSION_START = "<!-- MMCS:PRECOMPACT:START -->";
const SESSION_END = "<!-- MMCS:PRECOMPACT:END -->";

/** Hook JSON payload Claude Code pipes to PreCompact hooks (runbook §6). */
export interface PreCompactHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  trigger?: unknown;
  custom_instructions?: unknown;
}

export interface PreCompactResult {
  ok: true;
  repoRoot: string;
  trigger: string;
  lastCheckpointAt: string;
  sessionUpdated: boolean;
  ledgerAppended: boolean;
}

/** Coerce the loose hook payload into the strings we record. */
export function normalizeInput(raw: unknown): {
  trigger: string;
  sessionId: string;
  customInstructions: string;
} {
  const obj = (raw && typeof raw === "object" ? raw : {}) as PreCompactHookInput;
  const str = (v: unknown): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : "");
  return {
    trigger: str(obj.trigger) || "unknown",
    sessionId: str(obj.session_id),
    customInstructions: str(obj.custom_instructions),
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

/**
 * Marker-delimited session.md block: replaced in place on every pre-compact
 * so the file never accumulates one block per compaction.
 */
export function buildSessionBlock(state: {
  savedAt: string;
  lastCheckpointAt: string;
  trigger: string;
  sessionId: string;
}): string {
  const lines = [
    SESSION_START,
    "### PreCompact Checkpoint (auto — REC-002)",
    "",
    `- **Saved at:** ${state.savedAt}`,
    `- **Trigger:** ${state.trigger}`,
    `- **Checkpoint:** state/checkpoint.json (lastCheckpointAt ${state.lastCheckpointAt})`,
    `- **Session:** ${state.sessionId || "-"}`,
    "- **Resume order:** recovery.md → state/checkpoint.json → this file (runbook §5.2). Never recreate ACTIVE/PASS/MERGED tasks from the compact summary.",
    SESSION_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the marker block; falls back to append. */
export function upsertSessionBlock(existing: string, block: string): string {
  const start = existing.indexOf(SESSION_START);
  const end = existing.indexOf(SESSION_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + SESSION_END.length);
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

export interface RunPreCompactOptions {
  repoRoot: string;
  input?: unknown;
  lockOptions?: { timeoutMs?: number; staleMs?: number };
  now?: () => string;
}

/**
 * The full flush: checkpoint lock → checkpoint.json → session.md → ledger.
 * Everything inside one critical section so a concurrent flush/merge loop
 * cannot observe a half-updated resume state.
 */
export async function runPreCompact(opts: RunPreCompactOptions): Promise<PreCompactResult> {
  const repoRoot = opts.repoRoot;
  if (!repoRoot || repoRoot.trim() === "") {
    throw new Error("repoRoot is required");
  }
  const { trigger, sessionId, customInstructions } = normalizeInput(opts.input);
  const now = opts.now ?? nowIso;

  const wiring = new CheckpointWiring(repoRoot);
  let lastCheckpointAt = "";
  let sessionUpdated = false;
  let ledgerAppended = false;

  await withCheckpointLock(
    repoRoot,
    async () => {
      // 1. checkpoint.json — atomic write under the lock (invalidate first:
      // another process may have written since our last look).
      wiring.service.invalidate();
      const state = await wiring.service.update((draft) => {
        draft.nextActions = uniqueIds([
          PRECOMPACT_NEXT_ACTION,
          ...(customInstructions ? [`compact-instructions:${customInstructions}`] : []),
        ]);
      });
      lastCheckpointAt = state.lastCheckpointAt;

      // 2. session.md — idempotent marker block.
      const sessionPath = join(repoRoot, "session.md");
      let existing = "";
      try {
        existing = await readFile(sessionPath, "utf8");
      } catch {
        existing = "# Session State (session.md)\n";
      }
      const block = buildSessionBlock({
        savedAt: now(),
        lastCheckpointAt,
        trigger,
        sessionId,
      });
      const next = upsertSessionBlock(existing, block);
      if (next !== existing) {
        await atomicWriteText(sessionPath, next);
      }
      sessionUpdated = true;

      // 3. ledger.md — append-only PRECOMPACT_CHECKPOINT line.
      const ledgerPath = join(repoRoot, "ledger.md");
      const note = `trigger=${trigger}; checkpoint=state/checkpoint.json @ ${lastCheckpointAt}; session=${sessionId || "-"}`;
      await mkdir(dirname(ledgerPath), { recursive: true });
      await appendFile(ledgerPath, `| ${now()} | PRECOMPACT | pre-compact-hook | ${LEDGER_TAG} | ${note} |\n`);
      ledgerAppended = true;
    },
    opts.lockOptions,
  );

  return { ok: true, repoRoot, trigger, lastCheckpointAt, sessionUpdated, ledgerAppended };
}

/** Atomic text write (temp + rename) for session.md. */
async function atomicWriteText(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, filePath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI — invoked by .claude/hooks/pre-compact.sh. Exit 0 after a successful
// flush; exit 2 (block compaction) when the flush fails — save-first,
// compact-second.
// ---------------------------------------------------------------------------

export interface HookCliOptions {
  repoRoot?: string;
  trigger?: string;
  help?: boolean;
  selftest?: boolean;
}

const USAGE = `Usage: npx tsx scripts/hooks/pre-compact.ts [options]  < hook.json

PreCompact hook (REC-002): save-first, compact-second. Reads the Claude Code
hook JSON from stdin, then flushes checkpoint.json + session.md + a
PRECOMPACT_CHECKPOINT ledger line under the checkpoint lock before the
compaction runs.

Options:
  --repo-root <path>   Repo root (default: $MMCS_REPO_ROOT, else cwd)
  --trigger <name>     Override trigger when stdin has none
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
      case "--trigger":
        i += 1;
        if (i >= argv.length) throw new Error(`missing value for ${arg}`);
        opts.trigger = argv[i];
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
 * realistic PreCompact payload through the full flush against a temp repo
 * root and verifies all three artifacts.
 */
export async function selftest(log: (line: string) => void = () => undefined): Promise<void> {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "mmcs-precompact-selftest-"));
  try {
    const payload = {
      session_id: "selftest-session",
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: "selftest",
    };
    const result = await runPreCompact({ repoRoot: dir, input: payload });
    const checkpoint = JSON.parse(
      await readFile(join(dir, "state", "checkpoint.json"), "utf8"),
    ) as { lastCheckpointAt?: string; nextActions?: string[] };
    if (checkpoint.lastCheckpointAt !== result.lastCheckpointAt) {
      throw new Error("checkpoint lastCheckpointAt not stamped");
    }
    if (!checkpoint.nextActions?.includes(PRECOMPACT_NEXT_ACTION)) {
      throw new Error("checkpoint nextActions missing resume hint");
    }
    const session = await readFile(join(dir, "session.md"), "utf8");
    if (!session.includes(SESSION_START) || !session.includes("**Trigger:** auto")) {
      throw new Error("session.md block missing");
    }
    const ledger = await readFile(join(dir, "ledger.md"), "utf8");
    if (!ledger.includes(LEDGER_TAG)) {
      throw new Error(`ledger ${LEDGER_TAG} line missing`);
    }
    // Idempotent second flush: one marker block, ledger grows by one line.
    const ledgerLinesBefore = ledger.trimEnd().split("\n").length;
    await runPreCompact({ repoRoot: dir, input: payload });
    const session2 = await readFile(join(dir, "session.md"), "utf8");
    if (session2.split(SESSION_START).length - 1 !== 1) {
      throw new Error("session.md accumulated duplicate blocks");
    }
    const ledger2 = await readFile(join(dir, "ledger.md"), "utf8");
    if (ledger2.trimEnd().split("\n").length !== ledgerLinesBefore + 1) {
      throw new Error("ledger did not append exactly one line per flush");
    }
    log("precompact selftest: checkpoint + session + ledger verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log("PRECOMPACT SELFTEST PASS");
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
    io.stderr(`pre-compact hook: ${(err as Error).message}\n\n${USAGE}`);
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
      opts.trigger && rawInput && typeof rawInput === "object"
        ? { ...(rawInput as object), trigger: opts.trigger }
        : opts.trigger
          ? { trigger: opts.trigger }
          : rawInput;
    const result = await runPreCompact({ repoRoot, input });
    io.stdout(
      `pre-compact flush ok: trigger=${result.trigger} checkpoint=${result.lastCheckpointAt} ` +
        `session.md=${result.sessionUpdated ? "updated" : "unchanged"} ledger=${LEDGER_TAG} appended\n`,
    );
    return 0;
  } catch (err) {
    // Fail closed: block the compaction rather than lose the pre-compact
    // state. Claude Code surfaces stderr to the session on exit 2.
    io.stderr(`pre-compact hook flush FAILED — compaction must not proceed silently: ${(err as Error).message}\n`);
    return 2;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runHook(process.argv.slice(2));
}

// Run only when THIS module is the entry program (hook script / selftest),
// never on import from tests. Same guard pattern as REC-001's checkpoint CLI.
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
