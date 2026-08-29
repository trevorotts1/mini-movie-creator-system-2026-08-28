/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEDGER_TAG,
  SESSION_END_NEXT_ACTION,
  buildRecoveryBlock,
  normalizeInput,
  parseArgs,
  runHook,
  runSessionEnd,
  selftest,
  upsertRecoveryBlock,
} from "./session-end.js";
import { CHECKPOINT_FILE } from "../../packages/core/src/recovery/index.js";

describe("session-end hook (REC-005)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmcs-rec005-test-"));
    await mkdir(join(dir, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readCheckpoint = async () =>
    JSON.parse(await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8")) as Record<
      string,
      unknown
    >;

  describe("stdin parsing", () => {
    it("normalizes a realistic SessionEnd payload", () => {
      const { reason, sessionId } = normalizeInput({
        session_id: "abc-123",
        transcript_path: "/tmp/t.jsonl",
        hook_event_name: "SessionEnd",
        reason: "clear",
      });
      expect(reason).toBe("clear");
      expect(sessionId).toBe("abc-123");
    });

    it("tolerates empty / malformed / non-object stdin — save still proceeds", () => {
      expect(normalizeInput(null)).toEqual({ reason: "unknown", sessionId: "" });
      expect(normalizeInput(undefined).reason).toBe("unknown");
      expect(normalizeInput("garbage").reason).toBe("unknown");
      expect(normalizeInput({}).reason).toBe("unknown");
    });

    it("collapses whitespace in untrusted payload strings — no forged ledger rows", () => {
      // Hook stdin is untrusted text input: a reason/session_id carrying a
      // newline + table pipes must never become an extra ledger.md row or
      // break the single-line recovery.md format.
      const evil = "clear\n| 2020-01-01 | X-999 | attacker | FAKED | injected |\n";
      const { reason, sessionId } = normalizeInput({
        reason: evil,
        session_id: "s\t1\n|  x |",
      });
      expect(reason).toBe(
        "clear | 2020-01-01 | X-999 | attacker | FAKED | injected |",
      );
      expect(reason).not.toContain("\n");
      expect(sessionId).toBe("s 1 | x |");
      expect(sessionId).not.toContain("\n");
      expect(sessionId).not.toContain("\t");
    });

    it("flush output stays one ledger line / one recovery line per field with hostile payload", async () => {
      await runSessionEnd({
        repoRoot: dir,
        input: {
          reason: "a\n| t | FAKED-TASK | f | TAG | forged |\n",
          session_id: "z\n| t2 | FAKED | f2 | TAG2 | forged2 |",
        },
      });
      const ledger = await readFile(join(dir, "ledger.md"), "utf8");
      // Exactly one physical row: the injected "| ... |\n" table row becomes
      // inline text within the reason cell (whitespace collapsed), never an
      // independent ledger row the control plane could mistake for real.
      const rows = ledger.trimEnd().split("\n");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(LEDGER_TAG);
      expect(rows[0]).toContain("| REC-005 | session-end-hook |");
      const recovery = await readFile(join(dir, "recovery.md"), "utf8");
      expect(recovery.split("\n").filter((l) => l.includes("End reason"))).toHaveLength(1);
    });
  });

  describe("recovery.md block", () => {
    const base = {
      savedAt: "2026-08-28T00:00:00.000Z",
      lastCheckpointAt: "2026-08-28T00:00:01.000Z",
      reason: "clear",
      sessionId: "s1",
      repoRoot: "/repo",
      resume: {
        integrationSha: "a".repeat(40),
        mainSha: "b".repeat(40),
        lastKnownGoodCommit: "c".repeat(40),
        buildComplete: false,
        activeTaskIds: ["CORE-003"],
        nextActions: [SESSION_END_NEXT_ACTION],
      },
    };

    it("builds a marker-delimited block with reason + checkpoint stamp", () => {
      const block = buildRecoveryBlock(base);
      expect(block).toContain("<!-- MMCS:SESSION-END:START -->");
      expect(block).toContain("<!-- MMCS:SESSION-END:END -->");
      expect(block).toContain("**End reason:** clear");
      expect(block).toContain("2026-08-28T00:00:01.000Z");
    });

    it("records the EXACT resume command and state (runbook §26)", () => {
      const block = buildRecoveryBlock(base);
      expect(block).toContain("**EXACT RESUME COMMAND:**");
      expect(block).toContain("`cd /repo && claude`");
      expect(block).toContain("`" + "a".repeat(40) + "`");
      expect(block).toContain("**Active tasks:** CORE-003");
      expect(block).toContain("**buildComplete:** false");
      expect(block).toContain("/loop 10m /mmcs-watchdog");
    });

    it("handles null SHAs and buildComplete=true without loops hint", () => {
      const block = buildRecoveryBlock({
        ...base,
        resume: {
          integrationSha: null,
          mainSha: null,
          lastKnownGoodCommit: null,
          buildComplete: true,
          activeTaskIds: [],
          nextActions: [],
        },
      });
      expect(block).toContain("(derive with `git rev-parse <ref>` — not read at session end)");
      expect(block).toContain("**Active tasks:** (none)");
      expect(block).toContain("true — loops stay stopped");
      expect(block).not.toContain("/loop 10m");
    });

    it("replaces an existing block in place (idempotent, no accumulation)", () => {
      const first = buildRecoveryBlock(base);
      const second = buildRecoveryBlock({ ...base, reason: "logout" });
      const once = upsertRecoveryBlock("# Recovery\n\n---\n", first);
      const twice = upsertRecoveryBlock(once, second);
      expect(twice.split("<!-- MMCS:SESSION-END:START -->")).toHaveLength(2);
      expect(twice).toContain("**End reason:** logout");
      expect(twice).not.toContain("End reason:** clear");
    });

    it("appends after the first --- separator when no block exists yet", () => {
      const out = upsertRecoveryBlock("# Recovery\n\nbody\n", "<BLOCK/>");
      expect(out.indexOf("<BLOCK/>")).toBeGreaterThan(out.indexOf("# Recovery"));
    });
  });

  describe("full flush (final checkpoint + resume state)", () => {
    it("reads hook JSON from stdin path and updates checkpoint.json", async () => {
      const result = await runSessionEnd({
        repoRoot: dir,
        input: { session_id: "s-42", reason: "clear" },
      });
      expect(result.ok).toBe(true);
      const doc = await readCheckpoint();
      expect(doc.lastCheckpointAt).toBe(result.lastCheckpointAt);
      expect(doc.nextActions).toContain(SESSION_END_NEXT_ACTION);
      expect(
        (doc.nextActions as string[]).some((a) => a.startsWith("resume-command: ")),
      ).toBe(true);
    });

    it("updates recovery.md with exactly one marker block", async () => {
      await runSessionEnd({ repoRoot: dir, input: { reason: "clear" } });
      await runSessionEnd({ repoRoot: dir, input: { reason: "logout" } });
      const recovery = await readFile(join(dir, "recovery.md"), "utf8");
      expect(recovery.split("<!-- MMCS:SESSION-END:START -->")).toHaveLength(2);
      expect(recovery).toContain("**End reason:** logout");
      expect(recovery).toContain("EXACT RESUME COMMAND");
    });

    it("preserves the existing recovery.md content around the block", async () => {
      await writeFile(
        join(dir, "recovery.md"),
        "# Crash Recovery & Session Resume Protocol (recovery.md)\n\n---\n\n## 1. Resume Read Order\n\nbody\n",
      );
      await runSessionEnd({ repoRoot: dir, input: { reason: "clear" } });
      const recovery = await readFile(join(dir, "recovery.md"), "utf8");
      expect(recovery).toContain("# Crash Recovery & Session Resume Protocol (recovery.md)");
      expect(recovery).toContain("## 1. Resume Read Order");
      // Block lands after the first --- separator (top of the file — recovery
      //.md is first in the §5.2 read order, so the resume state is what a
      // fresh session sees first) and never breaks the existing sections.
      const blockAt = recovery.indexOf("EXACT RESUME COMMAND");
      expect(blockAt).toBeGreaterThan(-1);
      expect(blockAt).toBeLessThan(recovery.indexOf("## 1. Resume Read Order"));
      expect(recovery.trimEnd().endsWith("body")).toBe(true);
    });

    it("appends a SESSION_END_CHECKPOINT line to ledger.md per flush", async () => {
      await runSessionEnd({ repoRoot: dir, input: { reason: "clear" } });
      const first = await readFile(join(dir, "ledger.md"), "utf8");
      expect(first).toContain(LEDGER_TAG);
      expect(first.trimEnd().split("\n")).toHaveLength(1);
      await runSessionEnd({ repoRoot: dir, input: { reason: "clear" } });
      const second = await readFile(join(dir, "ledger.md"), "utf8");
      expect(second.trimEnd().split("\n")).toHaveLength(2);
    });

    it("runs two concurrent flushes without losing either (checkpoint lock)", async () => {
      await Promise.all([
        runSessionEnd({ repoRoot: dir, input: { reason: "clear" } }),
        runSessionEnd({ repoRoot: dir, input: { reason: "logout" } }),
      ]);
      const ledger = await readFile(join(dir, "ledger.md"), "utf8");
      expect(ledger.trimEnd().split("\n")).toHaveLength(2);
      const doc = await readCheckpoint(); // parses = complete file
      expect(doc.schemaVersion).toBe(1);
      const recovery = await readFile(join(dir, "recovery.md"), "utf8");
      expect(recovery.split("<!-- MMCS:SESSION-END:START -->")).toHaveLength(2);
    });

    it("records resume state: buildComplete=false, SHAs null outside a git repo", async () => {
      const result = await runSessionEnd({ repoRoot: dir, input: { reason: "clear" } });
      expect(result.resume.buildComplete).toBe(false);
      // Temp dir is not a git repo — git reads fail soft to null and
      // recovery re-derives SHAs; the flush must still succeed.
      expect(result.resume.integrationSha).toBeNull();
      expect(result.resume.mainSha).toBeNull();
      expect(result.resume.lastKnownGoodCommit).toBeNull();
    });

    it("fails closed with an error when repoRoot is missing", async () => {
      await expect(runSessionEnd({ repoRoot: "" })).rejects.toThrow(/repoRoot is required/);
    });
  });

  describe("hook CLI", () => {
    const stdinFrom = (text: string | null): NodeJS.ReadableStream => {
      const { Readable } = require("node:stream") as typeof import("node:stream");
      return text === null ? Readable.from([]) : Readable.from([text]);
    };

    it("exits 0 after a successful flush fed by hook JSON on stdin", async () => {
      const stdout: string[] = [];
      const code = await runHook(
        ["--repo-root", dir],
        {
          stdin: stdinFrom(
            JSON.stringify({
              session_id: "cli-session",
              hook_event_name: "SessionEnd",
              reason: "clear",
            }),
          ),
          stdout: (s) => stdout.push(s),
          stderr: () => undefined,
        },
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("flush ok");
      expect((await readCheckpoint()).nextActions).toContain(SESSION_END_NEXT_ACTION);
    });

    it("tolerates empty stdin and still exits 0 (save-first)", async () => {
      const code = await runHook(["--repo-root", dir], {
        stdin: stdinFrom(null),
        stdout: () => undefined,
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      await readCheckpoint();
    });

    it("exits 2 when the flush fails", async () => {
      // A repoRoot that is an existing FILE makes every write fail.
      const filePath = join(dir, "not-a-dir");
      await writeFile(filePath, "x");
      const stderr: string[] = [];
      const code = await runHook(["--repo-root", filePath], {
        stdin: stdinFrom(null),
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("flush FAILED");
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
    it("runs the real .claude/hooks/session-end.sh end-to-end and exits 0", async () => {
      // Simulate the real Claude Code invocation: the registered command runs
      // the repo's own .claude/hooks/session-end.sh with the hook JSON on
      // stdin. The flush target is redirected to the temp repo root via the
      // --repo-root flag the sh entry forwards to the TS implementation, so
      // the exercise covers the full chain: bash → tsx → runHook → flush.
      const shPath = new URL("../../.claude/hooks/session-end.sh", import.meta.url).pathname;
      const stats = await stat(shPath);
      expect(stats.mode & 0o111).not.toBe(0); // executable bit set
      const payload = JSON.stringify({
        session_id: "sim-session",
        hook_event_name: "SessionEnd",
        reason: "clear",
      });
      const out = execFileSync(
        "bash",
        [shPath, "--repo-root", dir, "--reason", "clear"],
        {
          input: payload,
          encoding: "utf8",
          env: { ...process.env, PATH: process.env.PATH },
        },
      );
      expect(out).toContain("flush ok");
      const doc = await readCheckpoint();
      expect(doc.nextActions).toContain(SESSION_END_NEXT_ACTION);
      const recovery = await readFile(join(dir, "recovery.md"), "utf8");
      expect(recovery).toContain("**End reason:** clear");
      expect(recovery).toContain("EXACT RESUME COMMAND");
      const ledger = await readFile(join(dir, "ledger.md"), "utf8");
      expect(ledger).toContain(LEDGER_TAG);
    }, 30_000);
  });

  describe("settings.json wiring", () => {
    it("registers the SessionEnd hook command in .claude/settings.json", async () => {
      const settingsPath = new URL("../../.claude/settings.json", import.meta.url).pathname;
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const entries = settings.hooks?.SessionEnd ?? [];
      expect(entries.length).toBeGreaterThan(0);
      const commands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
      expect(
        commands.some((c) => c.includes(".claude/hooks/session-end.sh")),
      ).toBe(true);
    });
  });

  describe("parseArgs", () => {
    it("parses flags", () => {
      expect(parseArgs(["--repo-root", "/x", "--reason", "clear", "--selftest"])).toEqual({
        repoRoot: "/x",
        reason: "clear",
        selftest: true,
      });
    });
    it("rejects missing values", () => {
      expect(() => parseArgs(["--repo-root"])).toThrow(/missing value/);
    });
  });

  describe("selftest", () => {
    it("passes end-to-end", async () => {
      const lines: string[] = [];
      await selftest((line) => lines.push(line));
      const out = lines.join("\n");
      expect(out).toContain("checkpoint + recovery + ledger verified");
      expect(out).toContain("SESSION-END SELFTEST PASS");
    });
  });
});
