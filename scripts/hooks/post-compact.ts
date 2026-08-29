/// <reference types="node" />
/**
 * REC-003 — PostCompact hook (spec.md §28 hooks; runbook §6 "PostCompact";
 * todo.md TASK-REC-003).
 *
 *   Claude Code fires this after a context compaction. Acceptance:
 *   records the event; updates the recovery marker; never treats the
 *   compact summary as the sole project state; simulated invocation passes.
 *
 * What it does, in order:
 *  1. Reads the hook JSON from stdin (session_id / transcript_path /
 *     trigger / custom_instructions). Payload fields are UNTRUSTED data:
 *     parsed defensively, control characters stripped, and the summary-like
 *     `custom_instructions` text is never persisted or echoed anywhere.
 *  2. Records the spec §28 `post-compact` cadence event through the REC-001
 *     wiring (`CheckpointWiring.postCompact`) — cross-process checkpoint
 *     lock, atomic temp+fsync+rename write to `state/checkpoint.json`.
 *     `nextActions` are deliberately left untouched: PreCompact (REC-002)
 *     owns setting them; PostCompact must not clobber them.
 *  3. Updates the recovery marker `state/recovery.json` (atomic write,
 *     additive fields only, prior `items`/`updated_at` preserved): the
 *     machine-readable pointer a resumed session reads FIRST. A corrupt
 *     marker is never silently reset — it is moved aside to
 *     `recovery.json.corrupt-<ts>` and replaced.
 *  4. Prints the disk-truth read order to stdout. For PostCompact, Claude
 *     Code adds stdout to the new context — so the resumed session is
 *     pointed back at the on-disk project state instead of relying on the
 *     compact summary. THE SUMMARY IS CONTEXT ONLY.
 *
 * Exit codes: 0 on success; 1 when the checkpoint event could not be
 * recorded (stderr names the reason — PostCompact has nothing to block, but
 * a failed durable write must surface, not vanish); 2 on usage errors.
 */
import { rename } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteJson,
  readJsonFileOrNull,
} from "../../packages/core/src/recovery/index.js";
import {
  CHECKPOINT_FILE,
  CheckpointWiring,
} from "../orchestration/checkpoint.js";

/** Recovery marker written by this hook (runbook §5 state/ file set). */
export const RECOVERY_MARKER_FILE = "recovery.json";

/**
 * The authoritative read order (recovery.md §1). The hook re-injects this
 * after every compaction so the summary can never become the only map.
 */
export const RECOVERY_READ_ORDER = [
  "recovery.md",
  "state/checkpoint.json",
  "build-status.md",
  "spec.md",
  "task-graph.md",
  "todo.md",
  "checklist.md",
  "qc.md",
  "integration-queue.md",
  "ownership.md",
  "ledger.md (tail 200)",
  "session.md (tail 200)",
] as const;

/** PostCompact hook payload (Claude Code). All fields optional/untrusted. */
export interface PostCompactPayload {
  session_id?: string;
  transcript_path?: string;
  trigger?: string;
  hook_event_name?: string;
}

/** One recovery-marker entry for a compaction event. */
export interface PostCompactMarkerEntry {
  at: string;
  trigger: string;
  session_id?: string;
  transcript_path?: string;
  /** true when the post-compact checkpoint cadence write succeeded. */
  checkpoint_ok: boolean;
  /** Timestamp of the checkpoint write when checkpoint_ok, else null. */
  checkpoint_at: string | null;
  checkpoint_file: string;
  writer: "scripts/hooks/post-compact.ts";
  note: string;
}

/** Strip control characters — payload strings are stored as opaque pointers. */
function sanitizeText(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (cleaned === "") return undefined;
  return cleaned.slice(0, maxLength);
}

/**
 * Parse the stdin payload defensively: anything that is not a JSON object
 * (non-JSON, arrays, scalars, empty stdin) yields trigger "unknown" and no
 * pointers. Never throws on bad input — a malformed payload must not stop
 * the event from being recorded.
 */
export function parsePayload(raw: string): PostCompactPayload {
  const fallback: PostCompactPayload = { trigger: "unknown" };
  if (raw.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  const doc = parsed as Record<string, unknown>;
  return {
    session_id: sanitizeText(doc.session_id),
    transcript_path: sanitizeText(doc.transcript_path),
    trigger: sanitizeText(doc.trigger) ?? "unknown",
    hook_event_name: sanitizeText(doc.hook_event_name),
  };
}

export interface PostCompactCliOptions {
  repoRoot?: string;
  help?: boolean;
}

const USAGE = `Usage: npx tsx scripts/hooks/post-compact.ts [options]

Claude Code PostCompact hook (REC-003). Reads the hook JSON payload from
stdin, records the spec §28 post-compact cadence event, updates the
state/recovery.json recovery marker, and prints the disk-truth read order.

Options:
  --repo-root <path>  Repo root this hook operates on (default: cwd)
  --help, -h          This help
`;

export function parseArgs(argv: readonly string[]): PostCompactCliOptions {
  const opts: PostCompactCliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--repo-root") {
      i += 1;
      const v = argv[i];
      if (!v) throw new Error("--repo-root requires a value");
      opts.repoRoot = v;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return opts;
}

interface RecoveryMarkerDoc {
  schema_version: number;
  items?: unknown[];
  /** Absent only in the fresh doc used before the first write. */
  updated_at?: string;
  recovery_read_order?: string[];
  last_post_compact?: PostCompactMarkerEntry;
  [key: string]: unknown;
}

/**
 * Read the existing recovery marker. Missing/empty → fresh doc; corrupt →
 * the file is moved aside (never silently reset) and a fresh doc is used.
 */
async function readMarker(
  markerPath: string,
  stderr: (s: string) => void,
): Promise<{ doc: RecoveryMarkerDoc; corruptBackup: string | null }> {
  try {
    const raw = await readJsonFileOrNull<RecoveryMarkerDoc>(markerPath);
    if (raw !== null) return { doc: raw, corruptBackup: null };
  } catch (err) {
    const backup = `${markerPath}.corrupt-${Date.now()}`;
    await rename(markerPath, backup);
    stderr(
      `post-compact hook: corrupt recovery marker at ${markerPath} ` +
        `moved to ${backup} (${(err as Error).message})\n`,
    );
    return { doc: { schema_version: 1 }, corruptBackup: backup };
  }
  return { doc: { schema_version: 1 }, corruptBackup: null };
}

export interface PostCompactIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
}

/** Run the PostCompact hook; returns the process exit code. */
export async function runPostCompact(
  argv: readonly string[],
  io: PostCompactIo,
): Promise<number> {
  let opts: PostCompactCliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    io.stdout(USAGE);
    return 0;
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const markerPath = join(repoRoot, "state", RECOVERY_MARKER_FILE);
  const checkpointPath = join(repoRoot, "state", CHECKPOINT_FILE);
  const payload = parsePayload(await io.readStdin());
  const at = new Date().toISOString();

  // 1. Record the spec §28 post-compact cadence event (checkpoint lock +
  //    atomic write). nextActions deliberately NOT touched (PreCompact owns
  //    them; PostCompact must not clobber the orchestrator's list).
  let checkpointOk = false;
  let checkpointAt: string | null = null;
  let checkpointError: string | null = null;
  try {
    const wiring = new CheckpointWiring(repoRoot);
    const state = await wiring.postCompact();
    checkpointOk = true;
    checkpointAt = state.lastCheckpointAt;
  } catch (err) {
    checkpointError = (err as Error).message;
  }

  // 2. Update the recovery marker regardless — a resumed session needs the
  //    pointer even when the checkpoint write failed (the marker records
  //    checkpoint_ok so the failure is visible, not hidden).
  const entry: PostCompactMarkerEntry = {
    at,
    trigger: payload.trigger ?? "unknown",
    ...(payload.session_id ? { session_id: payload.session_id } : {}),
    ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
    checkpoint_ok: checkpointOk,
    checkpoint_at: checkpointAt,
    checkpoint_file: checkpointPath,
    writer: "scripts/hooks/post-compact.ts",
    note:
      "compaction summary is context only — re-read project state from disk " +
      "(recovery_read_order) and reconcile runtime vs disk before acting",
  };
  const { doc, corruptBackup } = await readMarker(markerPath, io.stderr);
  const marker: RecoveryMarkerDoc = {
    ...doc,
    schema_version: 1,
    updated_at: at,
    recovery_read_order: [...RECOVERY_READ_ORDER],
    last_post_compact: entry,
  };
  await atomicWriteJson(markerPath, JSON.parse(JSON.stringify(marker)) as RecoveryMarkerDoc);

  // 3. Inject the disk-truth read order into the post-compact context
  //    (PostCompact stdout is added to the resumed session's context).
  io.stdout(
    [
      `[MMCS post-compact] event recorded ${at} (trigger: ${entry.trigger}); ` +
        `checkpoint ${checkpointOk ? "refreshed" : "FAILED"} -> ${checkpointPath}; ` +
        `recovery marker updated -> ${markerPath}` +
        (corruptBackup ? ` (corrupt previous marker moved to ${corruptBackup})` : ""),
      "[MMCS post-compact] The compaction summary is CONTEXT ONLY — never the " +
        "sole project state. Re-read from disk, in order:",
      ...RECOVERY_READ_ORDER.map((step) => `  - ${step}`),
      "[MMCS post-compact] Then reconcile runtime vs disk (git status, " +
        "git worktree list, git branch -a) before acting.",
      "",
    ].join("\n"),
  );

  if (!checkpointOk) {
    io.stderr(`post-compact hook: checkpoint event failed: ${checkpointError}\n`);
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runPostCompact(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  });
}

// Run only when THIS module is the entry program (tsx script / CLI), never on
// import from tests or other modules. argv[1] is the executed file path.
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
