/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MMCS_TASK_ID_PATTERN,
  evaluateTaskCompletion,
  normalizeInput,
  parseArgs,
  readTasksJson,
  runHook,
  selftest,
} from "./task-completed.js";

describe("task-completed hook (REC-006)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmcs-rec006-test-"));
    await mkdir(join(dir, "state", "task-updates"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeTasks = async (items: object[]) => {
    await writeFile(
      join(dir, "state", "tasks.json"),
      JSON.stringify({ schema_version: 1, updated_at: "t", items }, null, 2),
    );
  };

  const writeBuilder = async (id: string, extra: object = {}) => {
    await writeFile(
      join(dir, "state", "task-updates", `${id}.builder.json`),
      JSON.stringify({
        taskId: id,
        phase: "BUILDER_DONE",
        commit: "abc1234",
        testsRun: "npx vitest run x.test.ts → 12/12 PASS",
        notes: "ok",
        blockers: [],
        ...extra,
      }),
    );
  };

  const writeQc = async (id: string, extra: object = {}) => {
    await writeFile(
      join(dir, "state", "task-updates", `${id}.qc.json`),
      JSON.stringify({
        taskId: id,
        phase: "PASS",
        finalTestResult: "PASS",
        defectsFound: 0,
        defectsFixed: 0,
        blockers: [],
        ...extra,
      }),
    );
  };

  /** A task record with the full evidence trail (branch, worktree, PASS). */
  const writeFullyEvidencedTask = async (id: string, status = "PASS") => {
    await writeTasks([
      { id, status, branch: `task/${id}-slug`, worktree: `worktrees/${id}/` },
    ]);
    await writeBuilder(id);
    await writeQc(id);
  };

  describe("normalizeInput", () => {
    it("extracts task_id from a realistic TaskCompleted payload", () => {
      const { taskId, sessionId } = normalizeInput({
        session_id: "s-9",
        transcript_path: "/tmp/t.jsonl",
        hook_event_name: "TaskCompleted",
        task_id: "REC-006",
      });
      expect(taskId).toBe("REC-006");
      expect(sessionId).toBe("s-9");
    });

    it("tolerates camelCase, nested task object, empty and non-object stdin", () => {
      expect(normalizeInput({ taskId: "DIR-003" }).taskId).toBe("DIR-003");
      expect(normalizeInput({ task: { id: "CAP-001" } }).taskId).toBe("CAP-001");
      expect(normalizeInput(null).taskId).toBe("");
      expect(normalizeInput(undefined).taskId).toBe("");
      expect(normalizeInput("garbage").taskId).toBe("");
      expect(normalizeInput({ task_id: "   " }).taskId).toBe("");
    });
  });

  describe("task id vocabulary", () => {
    it("matches MMCS task ids and rejects non-MMCS ids", () => {
      expect(MMCS_TASK_ID_PATTERN.test("REC-006")).toBe(true);
      expect(MMCS_TASK_ID_PATTERN.test("CAP-003")).toBe(true);
      expect(MMCS_TASK_ID_PATTERN.test("TOOL-01")).toBe(true);
      expect(MMCS_TASK_ID_PATTERN.test("12")).toBe(false);
      expect(MMCS_TASK_ID_PATTERN.test("task-1")).toBe(false);
      expect(MMCS_TASK_ID_PATTERN.test("")).toBe(false);
    });

    it("allows a non-MMCS task id without opinion", async () => {
      const out = await evaluateTaskCompletion(dir, "123");
      expect(out.allowed).toBe(true);
      expect(out.reason).toBe("NOT_MMCS_TASK");
    });
  });

  describe("evaluateTaskCompletion — the gate", () => {
    it("blocks a task that is not registered in state/tasks.json", async () => {
      const out = await evaluateTaskCompletion(dir, "REC-006");
      expect(out.allowed).toBe(false);
      expect(out.reason).toBe("TASK_NOT_REGISTERED");
      expect(out.remaining[0]).toContain("not registered in state/tasks.json");
      expect(out.remaining[0]).toContain("REC-006");
    });

    it("blocks when branch or worktree are unrecorded and names exactly what remains", async () => {
      await writeTasks([{ id: "AA-1", status: "ACTIVE", branch: "", worktree: "" }]);
      const out = await evaluateTaskCompletion(dir, "AA-1");
      expect(out.allowed).toBe(false);
      expect(out.remaining.some((r) => r.includes('records no branch'))).toBe(true);
      expect(out.remaining.some((r) => r.includes('records no worktree'))).toBe(true);
      expect(out.remaining.some((r) => r.includes("no builder test evidence"))).toBe(true);
    });

    it("blocks when no builder test evidence exists", async () => {
      await writeTasks([
        { id: "BB-1", status: "BUILDER_DONE", branch: "task/b-1", worktree: "worktrees/B-1/" },
      ]);
      const out = await evaluateTaskCompletion(dir, "BB-1");
      expect(out.allowed).toBe(false);
      expect(out.remaining.some((r) => r.includes("no builder test evidence"))).toBe(true);
    });

    it("blocks when builder testsRun is empty or records FAIL", async () => {
      await writeTasks([
        { id: "CC-1", status: "BUILDER_DONE", branch: "task/c-1", worktree: "worktrees/C-1/" },
      ]);
      await writeBuilder("CC-1", { testsRun: "" });
      let out = await evaluateTaskCompletion(dir, "CC-1");
      expect(out.remaining.some((r) => r.includes('empty "testsRun"'))).toBe(true);

      await writeBuilder("CC-1", { testsRun: "npx vitest run x → 11/12 FAIL" });
      out = await evaluateTaskCompletion(dir, "CC-1");
      expect(out.remaining.some((r) => r.includes("records FAIL"))).toBe(true);

      // An explicit zero-fail phrasing is not a failure record.
      await writeBuilder("CC-1", { testsRun: "npx vitest run x → 12/12 PASS, 0 FAIL" });
      out = await evaluateTaskCompletion(dir, "CC-1");
      expect(out.remaining.some((r) => r.includes("records FAIL"))).toBe(false);
    });

    it("blocks when no QC evidence exists (QC PASS where required)", async () => {
      await writeTasks([
        { id: "DD-1", status: "BUILDER_DONE", branch: "task/d-1", worktree: "worktrees/D-1/" },
      ]);
      await writeBuilder("DD-1");
      const out = await evaluateTaskCompletion(dir, "DD-1");
      expect(out.allowed).toBe(false);
      expect(out.remaining.some((r) => r.includes("no QC evidence"))).toBe(true);
    });

    it("blocks when QC verdict is not PASS and names the verdict", async () => {
      await writeTasks([
        { id: "EE-1", status: "QC_FIXING", branch: "task/e-1", worktree: "worktrees/E-1/" },
      ]);
      await writeBuilder("EE-1");
      await writeQc("EE-1", { phase: "QC_FIXING" });
      const out = await evaluateTaskCompletion(dir, "EE-1");
      expect(out.allowed).toBe(false);
      expect(out.remaining.some((r) => r.includes("QC_FIXING, not PASS"))).toBe(true);
    });

    it("blocks a QC PASS that still carries open blockers", async () => {
      await writeTasks([
        { id: "FF-1", status: "PASS", branch: "task/f-1", worktree: "worktrees/F-1/" },
      ]);
      await writeBuilder("FF-1");
      await writeQc("FF-1", { blockers: ["AWAITING upstream API"] });
      const out = await evaluateTaskCompletion(dir, "FF-1");
      expect(out.allowed).toBe(false);
      expect(out.remaining.some((r) => r.includes("open blockers"))).toBe(true);
    });

    it("honors the record-level qcRequired: false opt-out", async () => {
      await writeTasks([
        {
          id: "GG-1",
          status: "PASS",
          branch: "task/g-1",
          worktree: "worktrees/G-1/",
          qcRequired: false,
        },
      ]);
      await writeBuilder("GG-1");
      const out = await evaluateTaskCompletion(dir, "GG-1");
      expect(out.allowed).toBe(true);
      expect(out.remaining.some((r) => r.includes("QC"))).toBe(false);
    });

    it("blocks an ACTIVE→MERGED jump: MERGED status without the evidence trail", async () => {
      // Jump case 1: builder + QC missing entirely.
      await writeTasks([
        { id: "HH-1", status: "MERGED", branch: "task/h-1", worktree: "worktrees/H-1/" },
      ]);
      let out = await evaluateTaskCompletion(dir, "HH-1");
      expect(out.allowed).toBe(false);
      const jumpMsg = out.remaining.find((r) => r.includes("ACTIVE→MERGED jump"));
      expect(jumpMsg).toBeDefined();
      expect(jumpMsg).toContain("builder evidence: missing");
      expect(jumpMsg).toContain("QC PASS: missing");

      // Jump case 2: builder present but QC absent — still a jump.
      await writeBuilder("HH-1");
      out = await evaluateTaskCompletion(dir, "HH-1");
      expect(out.allowed).toBe(false);
      const jump2 = out.remaining.find((r) => r.includes("ACTIVE→MERGED jump"));
      expect(jump2).toContain("QC PASS: missing");

      // A non-merged task with the same gaps is flagged by the other checks,
      // not the jump check (jump is about the status claim).
      await writeTasks([
        { id: "HH-2", status: "ACTIVE", branch: "task/h-2", worktree: "worktrees/H-2/" },
      ]);
      const out2 = await evaluateTaskCompletion(dir, "HH-2");
      expect(out2.remaining.find((r) => r.includes("ACTIVE→MERGED jump"))).toBeUndefined();
    });

    it("allows a fully-evidenced task (exit-0 path)", async () => {
      await writeFullyEvidencedTask("II-1");
      const out = await evaluateTaskCompletion(dir, "II-1");
      expect(out.allowed).toBe(true);
      expect(out.remaining).toEqual([]);
      expect(out.reason).toBe("EVIDENCE_COMPLETE");
    });

    it("collects ALL remaining gaps in one pass, not just the first", async () => {
      await writeTasks([{ id: "JJ-1", status: "BUILDER_DONE", branch: "", worktree: "" }]);
      const out = await evaluateTaskCompletion(dir, "JJ-1");
      expect(out.allowed).toBe(false);
      // branch + worktree + builder + QC = 4 named gaps.
      expect(out.remaining).toHaveLength(4);
    });
  });

  describe("readTasksJson", () => {
    it("indexes tasks by id and tolerates a missing/corrupt file", async () => {
      await writeTasks([{ id: "KK-1", status: "ACTIVE", branch: "b" }]);
      const ok = await readTasksJson(join(dir, "state", "tasks.json"));
      expect(ok.get("KK-1")?.status).toBe("ACTIVE");
      expect(ok.size).toBe(1);
      const missing = await readTasksJson(join(dir, "state", "nope.json"));
      expect(missing.size).toBe(0);
      await writeFile(join(dir, "state", "bad.json"), "{not json");
      const corrupt = await readTasksJson(join(dir, "state", "bad.json"));
      expect(corrupt.size).toBe(0);
    });
  });

  describe("hook CLI", () => {
    const stdinFrom = (text: string | null): NodeJS.ReadableStream => {
      const { Readable } = require("node:stream") as typeof import("node:stream");
      return text === null ? Readable.from([]) : Readable.from([text]);
    };

    it("exits 0 when the evidence trail is complete", async () => {
      await writeFullyEvidencedTask("LL-1");
      const stdout: string[] = [];
      const code = await runHook(
        ["--repo-root", dir, "--task-id", "LL-1"],
        {
          stdin: stdinFrom(JSON.stringify({ hook_event_name: "TaskCompleted", task_id: "LL-1" })),
          stdout: (s) => stdout.push(s),
          stderr: () => undefined,
        },
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("ALLOW task LL-1");
    });

    it("exits 2 with the named gaps when evidence is missing", async () => {
      await writeTasks([{ id: "MM-1", status: "ACTIVE", branch: "", worktree: "" }]);
      const stderr: string[] = [];
      const code = await runHook(
        ["--repo-root", dir, "--task-id", "MM-1"],
        { stdin: stdinFrom(null), stdout: () => undefined, stderr: (s) => stderr.push(s) },
      );
      expect(code).toBe(2);
      const feedback = stderr.join("");
      expect(feedback).toContain("BLOCKED");
      expect(feedback).toContain("records no branch");
      expect(feedback).toContain("records no worktree");
      expect(feedback).toContain("no builder test evidence");
      expect(feedback).toContain("no QC evidence");
    });

    it("exits 2 when the payload carries no task id and no flag is given", async () => {
      const stderr: string[] = [];
      const code = await runHook(["--repo-root", dir], {
        stdin: stdinFrom(null),
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("no task ID in the hook payload");
    });

    it("lets --task-id override a missing payload id", async () => {
      await writeFullyEvidencedTask("NN-1");
      const code = await runHook(["--repo-root", dir, "--task-id", "NN-1"], {
        stdin: stdinFrom(null),
        stdout: () => undefined,
        stderr: () => undefined,
      });
      expect(code).toBe(0);
    });

    it("fails closed exit 2 on an unusable repo root", async () => {
      const stderr: string[] = [];
      const code = await runHook(
        ["--repo-root", join(dir, "missing-root"), "--task-id", "OO-1"],
        { stdin: stdinFrom(null), stdout: () => undefined, stderr: (s) => stderr.push(s) },
      );
      // Missing tasks.json ⇒ task not registered ⇒ blocked. Either way the
      // gate never allows a close it could not verify.
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("BLOCKED");
    });

    it("exits 2 on an unknown option", async () => {
      const stderr: string[] = [];
      const code = await runHook(["--bogus"], {
        stdin: stdinFrom(null),
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("unknown option");
    });

    it("prints usage on --help and exits 0", async () => {
      const stdout: string[] = [];
      const code = await runHook(["--help"], {
        stdin: stdinFrom(null),
        stdout: (s) => stdout.push(s),
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("Usage:");
    });
  });

  describe("simulated hook invocation (executable sh entry)", () => {
    it("runs the real .claude/hooks/task-completed.sh end-to-end — missing evidence exits 2, complete evidence exits 0", async () => {
      // Simulate the real Claude Code invocation: the registered command runs
      // the repo's own .claude/hooks/task-completed.sh with the hook JSON on
      // stdin. The gate target is redirected to the temp repo root via the
      // --repo-root flag the sh entry forwards to the TS implementation, so
      // the exercise covers the full chain: bash → tsx → runHook → gate.
      const shPath = new URL("../../.claude/hooks/task-completed.sh", import.meta.url).pathname;
      const stats = await stat(shPath);
      expect(stats.mode & 0o111).not.toBe(0); // executable bit set

      await writeTasks([{ id: "PP-1", status: "ACTIVE", branch: "", worktree: "" }]);
      // Exit 2 is surfaced by execFileSync as an exception carrying stderr —
      // the blocking feedback lives on stderr by the hook contract.
      let blockedFeedback = "";
      let blockedCode: number | null = null;
      try {
        execFileSync("bash", [shPath, "--repo-root", dir, "--task-id", "PP-1"], {
          input: "{}",
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        blockedCode = (err as { status?: number }).status ?? null;
        blockedFeedback = String(
          (err as { stderr?: Buffer | string }).stderr ?? "",
        );
      }
      expect(blockedCode).toBe(2);
      expect(blockedFeedback).toContain("BLOCKED");
      expect(blockedFeedback).toContain("records no branch");
      expect(blockedFeedback).toContain("records no worktree");
      expect(blockedFeedback).toContain("no builder test evidence");
      expect(blockedFeedback).toContain("no QC evidence");

      await writeFullyEvidencedTask("PP-1");
      const allowed = execFileSync(
        "bash",
        [shPath, "--repo-root", dir, "--task-id", "PP-1"],
        { input: "{}", encoding: "utf8" },
      );
      expect(allowed).toContain("ALLOW task PP-1");
    }, 60_000);
  });

  describe("parseArgs", () => {
    it("parses flags", () => {
      expect(parseArgs(["--repo-root", "/x", "--task-id", "REC-006", "--selftest"])).toEqual({
        repoRoot: "/x",
        taskId: "REC-006",
        selftest: true,
      });
    });
    it("rejects missing values", () => {
      expect(() => parseArgs(["--task-id"])).toThrow(/missing value/);
      expect(() => parseArgs(["--repo-root"])).toThrow(/missing value/);
    });
  });

  describe("selftest", () => {
    it("passes end-to-end", async () => {
      const lines: string[] = [];
      await selftest((line) => lines.push(line));
      const out = lines.join("\n");
      expect(out).toContain("allowed; TST-002 blocked");
      expect(out).toContain("TASKCOMPLETED SELFTEST PASS");
    });
  });
});
