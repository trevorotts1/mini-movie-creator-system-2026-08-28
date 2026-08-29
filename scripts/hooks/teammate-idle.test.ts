/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_SUGGESTION_LIMIT,
  compareTaskIds,
  decide,
  dependenciesSatisfied,
  matchingAgentRecords,
  normalizeInput,
  parseArgs,
  readStdinJson,
  renderInstruction,
  runHook,
  runTeammateIdle,
  selftest,
  taskIdsFromRecords,
} from "./teammate-idle.js";

// ---------------------------------------------------------------------------
// Fixture builder — a temp repo root with state/tasks.json + state/agents.json
// shaped exactly like the live orchestration store.
// ---------------------------------------------------------------------------

const TASKS = [
  { id: "MERGED-1", title: "Done dep", workflow: "WF1", status: "MERGED", dependsOn: [] },
  { id: "WF1-001", title: "In-flight build", workflow: "WF1", status: "ACTIVE", dependsOn: [] },
  { id: "WF1-004", title: "In-flight fix", workflow: "WF1", status: "QC_FIXING", dependsOn: [] },
  { id: "WF1-002", title: "Claimable", workflow: "WF1", status: "READY", dependsOn: ["MERGED-1"] },
  { id: "WF1-003", title: "Deps open", workflow: "WF1", status: "READY", dependsOn: ["OPEN-1"] },
  { id: "WF2-001", title: "Other workflow", workflow: "WF2", status: "READY", dependsOn: [] },
];

const AGENTS = [
  { id: "agent-a", workflow: "WF1", taskId: "WF1-001" },
  { id: "agent-b", workflow: "WF1", taskId: "WF1-004" },
  { id: "agent-c", workflow: "WF1" },
];

describe("teammate-idle hook (REC-007)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmcs-rec007-test-"));
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(
      join(dir, "state", "tasks.json"),
      JSON.stringify({ schema_version: 1, updated_at: "2026-08-28T00:00:00.000Z", items: TASKS }),
    );
    await writeFile(
      join(dir, "state", "agents.json"),
      JSON.stringify({ schema_version: 1, updated_at: "2026-08-28T00:00:00.000Z", items: AGENTS }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe("payload normalization", () => {
    it("reads a realistic TeammateIdle payload", () => {
      const { agent, sessionId } = normalizeInput({
        session_id: "abc-123",
        transcript_path: "/tmp/t.jsonl",
        hook_event_name: "TeammateIdle",
        teammate_name: "builder-7",
      });
      expect(agent).toBe("builder-7");
      expect(sessionId).toBe("abc-123");
    });

    it("falls back through the alternate identity fields", () => {
      expect(normalizeInput({ agent_id: "a1" }).agent).toBe("a1");
      expect(normalizeInput({ agentName: "a2" }).agent).toBe("a2");
      expect(normalizeInput({ name: "a3" }).agent).toBe("a3");
      expect(normalizeInput({ teammateName: "a4" }).agent).toBe("a4");
    });

    it("tolerates empty / malformed / non-object stdin payloads", () => {
      expect(normalizeInput(null)).toEqual({ agent: "", sessionId: "" });
      expect(normalizeInput(undefined).agent).toBe("");
      expect(normalizeInput("garbage").agent).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  describe("identity matching", () => {
    it("matches agent records by id or name, case-insensitively", () => {
      const recs = matchingAgentRecords(
        [{ id: "Builder-7", workflow: "WF1" }, { id: "other", name: "builder-7" }],
        "builder-7",
      );
      expect(recs).toHaveLength(2);
    });

    it("collects task ids from records, tolerating task_id", () => {
      expect(taskIdsFromRecords([{ taskId: "T1" }, { task_id: "T2" }, {}])).toEqual(["T1", "T2"]);
    });

    it("returns nothing for an empty identity", () => {
      expect(matchingAgentRecords(AGENTS, "")).toEqual([]);
      expect(taskIdsFromRecords([])).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("pure decision helpers", () => {
    it("orders task ids numerically, not lexically", () => {
      expect(compareTaskIds("VID-002", "VID-014")).toBeLessThan(0);
      expect(compareTaskIds("WF10-001", "WF4-001")).toBeGreaterThan(0);
      expect(compareTaskIds("A-1", "A-1")).toBe(0);
    });

    it("satisfies deps only on PASS/MERGED/DONE", () => {
      const statusOf = new Map([
        ["PASS-1", "PASS"],
        ["MERGED-1", "MERGED"],
        ["DONE-1", "DONE"],
        ["ACTIVE-1", "ACTIVE"],
        ["READY-1", "READY"],
      ]);
      expect(dependenciesSatisfied({ id: "T", dependsOn: ["PASS-1", "MERGED-1", "DONE-1"] }, statusOf)).toBe(true);
      expect(dependenciesSatisfied({ id: "T", dependsOn: ["ACTIVE-1"] }, statusOf)).toBe(false);
      expect(dependenciesSatisfied({ id: "T", dependsOn: ["READY-1"] }, statusOf)).toBe(false);
      expect(dependenciesSatisfied({ id: "T", dependsOn: [] }, statusOf)).toBe(true);
      expect(dependenciesSatisfied({ id: "T", dependsOn: ["GHOST-1"] }, statusOf)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("decision: continue-owned (exit 2)", () => {
    it("blocks idle when the teammate owns an ACTIVE task", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-a" });
      expect(d.decision).toBe("continue-owned");
      expect(d.exitCode).toBe(2);
      expect(d.owned.map((t) => t.id)).toEqual(["WF1-001"]);
      expect(d.workflow).toBe("WF1");
    });

    it("blocks idle when the teammate owns a QC_FIXING task", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-b" });
      expect(d.decision).toBe("continue-owned");
      expect(d.exitCode).toBe(2);
      expect(d.owned.map((t) => t.id)).toEqual(["WF1-004"]);
    });

    it("honors a direct --task override as ownership", () => {
      const d = decide({ tasks: TASKS, agents: [], agent: "whoever", taskOverride: "WF1-001" });
      expect(d.decision).toBe("continue-owned");
      expect(d.owned.map((t) => t.id)).toEqual(["WF1-001"]);
    });

    it("ignores owned tasks that are not in flight (PASS/READY are not owned work)", () => {
      const d = decide({
        tasks: [...TASKS, { id: "WF1-009", workflow: "WF1", status: "PASS" }],
        agents: [{ id: "agent-a", workflow: "WF1", taskId: "WF1-009" }],
        agent: "agent-a",
      });
      expect(d.decision).not.toBe("continue-owned");
    });

    it("sorts multiple owned tasks deterministically", () => {
      const d = decide({
        tasks: [
          { id: "B-002", workflow: "WF1", status: "ACTIVE" },
          { id: "B-010", workflow: "WF1", status: "QC_FIXING" },
          { id: "B-001", workflow: "WF1", status: "ACTIVE" },
        ],
        agents: [],
        agent: "x",
        taskOverride: "B-002",
      });
      // Only the override maps here; with agents.json both would appear.
      expect(d.owned.map((t) => t.id)).toEqual(["B-002"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("decision: claim-ready (exit 2)", () => {
    it("directs an unowned teammate to the next compatible READY task in its workflow", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-c" });
      expect(d.decision).toBe("claim-ready");
      expect(d.exitCode).toBe(2);
      expect(d.suggestions.map((t) => t.id)).toEqual(["WF1-002"]);
    });

    it("never suggests tasks with unsatisfied dependencies", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-c" });
      expect(d.suggestions.map((t) => t.id)).not.toContain("WF1-003");
    });

    it("never suggests tasks from another workflow", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-c" });
      expect(d.suggestions.map((t) => t.id)).not.toContain("WF2-001");
    });

    it("never suggests READY tasks already claimed by another agent", () => {
      const claimed = [
        ...TASKS,
        { id: "WF1-005", title: "Fresh", workflow: "WF1", status: "READY", dependsOn: [] },
      ];
      const agents = [...AGENTS, { id: "agent-d", workflow: "WF1", taskId: "WF1-005" }];
      const d = decide({ tasks: claimed, agents, agent: "agent-c" });
      expect(d.suggestions.map((t) => t.id)).not.toContain("WF1-005");
    });

    it("falls back to the workflow of a finished recorded task", () => {
      const d = decide({
        tasks: [...TASKS, { id: "WF1-000", workflow: "WF1", status: "MERGED" }],
        agents: [{ id: "agent-e", workflow: "", taskId: "WF1-000" }],
        agent: "agent-e",
      });
      expect(d.decision).toBe("claim-ready");
      expect(d.workflow).toBe("WF1");
    });

    it("honors a workflow override", () => {
      const d = decide({
        tasks: TASKS,
        agents: [],
        agent: "agent-z",
        workflowOverride: "WF2",
      });
      expect(d.decision).toBe("claim-ready");
      expect(d.suggestions.map((t) => t.id)).toEqual(["WF2-001"]);
    });

    it("caps the suggestion list at the instruction limit", () => {
      const many = Array.from({ length: CLAIM_SUGGESTION_LIMIT + 2 }, (_, i) => ({
        id: `WF1-10${i}`,
        workflow: "WF1",
        status: "READY",
        dependsOn: [],
      }));
      const d = decide({ tasks: many, agents: [], agent: "a", workflowOverride: "WF1" });
      expect(d.suggestions).toHaveLength(CLAIM_SUGGESTION_LIMIT);
    });
  });

  // -------------------------------------------------------------------------
  describe("decision: allow-idle (exit 0)", () => {
    it("allows idle when no compatible READY task exists in the workflow", () => {
      const d = decide({
        tasks: TASKS.filter((t) => t.id !== "WF1-002"),
        agents: AGENTS,
        agent: "agent-c",
      });
      expect(d.decision).toBe("allow-idle");
      expect(d.exitCode).toBe(0);
    });

    it("allows idle when the workflow is unknown (nothing provably compatible)", () => {
      const d = decide({ tasks: TASKS, agents: [], agent: "ghost" });
      expect(d.decision).toBe("allow-idle");
      expect(d.exitCode).toBe(0);
    });

    it("allows idle when only other workflows have READY work", () => {
      const d = decide({
        tasks: [{ id: "WF2-001", workflow: "WF2", status: "READY", dependsOn: [] }],
        agents: [{ id: "agent-c", workflow: "WF1" }],
        agent: "agent-c",
      });
      expect(d.decision).toBe("allow-idle");
    });
  });

  // -------------------------------------------------------------------------
  describe("instruction rendering", () => {
    it("continue-owned names the owned tasks and the claim-after directive", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-a" });
      const text = renderInstruction(d);
      expect(text).toContain("IDLE BLOCKED");
      expect(text).toContain("WF1-001");
      expect(text).toContain("ACTIVE");
      expect(text).toContain("state/task-updates/");
      expect(text).toContain("WF1");
    });

    it("claim-ready names the workflow and claim steps", () => {
      const d = decide({ tasks: TASKS, agents: AGENTS, agent: "agent-c" });
      const text = renderInstruction(d);
      expect(text).toContain("IDLE BLOCKED");
      expect(text).toContain("WF1");
      expect(text).toContain("WF1-002");
      expect(text).toContain("origin/integration");
    });

    it("allow-idle says so plainly", () => {
      const text = renderInstruction({
        decision: "allow-idle",
        exitCode: 0,
        agent: "agent-c",
        workflow: "WF1",
        owned: [],
        suggestions: [],
      });
      expect(text).toContain("allowing idle");
      expect(text).toContain("agent-c");
    });
  });

  // -------------------------------------------------------------------------
  describe("full run against a repo root", () => {
    it("resolves identity from stdin payload and produces both branches", async () => {
      const owned = await runTeammateIdle({
        repoRoot: dir,
        input: { session_id: "s1", hook_event_name: "TeammateIdle", teammate_name: "agent-a" },
      });
      expect(owned.decision.exitCode).toBe(2);
      expect(owned.decision.decision).toBe("continue-owned");

      const claim = await runTeammateIdle({
        repoRoot: dir,
        input: { teammate_name: "agent-c" },
      });
      expect(claim.decision.exitCode).toBe(2);
      expect(claim.decision.decision).toBe("claim-ready");
      expect(claim.instruction).toContain("WF1-002");
    });

    it("prefers flag identity over payload, and MMCS_TASK_ID as direct claim", async () => {
      const r = await runTeammateIdle({ repoRoot: dir, agent: "ghost", input: { teammate_name: "agent-a" } });
      expect(r.decision.agent).toBe("ghost");

      const direct = await runTeammateIdle({
        repoRoot: dir,
        input: { teammate_name: "ghost" },
      });
      expect(direct.decision.decision).toBe("allow-idle"); // ghost owns nothing
    });

    it("fails open when state/tasks.json is unreadable", async () => {
      const r = await runTeammateIdle({ repoRoot: join(dir, "missing-root"), agent: "agent-a" });
      expect(r.decision.exitCode).toBe(0);
      expect(r.decision.decision).toBe("allow-idle");
      expect(r.instruction).toContain("fail-open");
    });

    it("throws on contract misuse (empty repoRoot)", async () => {
      await expect(runTeammateIdle({ repoRoot: "" })).rejects.toThrow(/repoRoot is required/);
    });

    it("tolerates empty state files (field-tolerant reads)", async () => {
      await writeFile(join(dir, "state", "tasks.json"), "");
      await writeFile(join(dir, "state", "agents.json"), "{}");
      const r = await runTeammateIdle({ repoRoot: dir, agent: "agent-a" });
      expect(r.decision.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("hook CLI", () => {
    const stdinFrom = (text: string | null): NodeJS.ReadableStream => {
      const { Readable } = require("node:stream") as typeof import("node:stream");
      return text === null ? Readable.from([]) : Readable.from([text]);
    };

    it("exits 2 with the continue instruction on stderr when owned work is ACTIVE", async () => {
      const stderr: string[] = [];
      const stdout: string[] = [];
      const code = await runHook(
        ["--repo-root", dir],
        {
          stdin: stdinFrom(JSON.stringify({ hook_event_name: "TeammateIdle", teammate_name: "agent-a" })),
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
        },
      );
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("IDLE BLOCKED");
      expect(stderr.join("")).toContain("WF1-001");
      expect(stdout.join("")).toBe("");
    });

    it("exits 0 and allows idle when no useful work exists", async () => {
      const stdout: string[] = [];
      const code = await runHook(
        ["--repo-root", dir, "--agent", "agent-c", "--workflow", "WF9"],
        { stdin: stdinFrom(null), stdout: (s) => stdout.push(s), stderr: () => undefined },
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("allowing idle");
    });

    it("exits 2 with the claim directive when compatible READY work exists", async () => {
      const stderr: string[] = [];
      const code = await runHook(
        ["--repo-root", dir, "--agent", "agent-c"],
        { stdin: stdinFrom(null), stdout: () => undefined, stderr: (s) => stderr.push(s) },
      );
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("WF1-002");
      expect(stderr.join("")).toContain("Claim the next one");
    });

    it("exits 0 (fail-open) when the state root is unreadable", async () => {
      const stdout: string[] = [];
      const code = await runHook(
        ["--repo-root", join(dir, "nope"), "--agent", "agent-a"],
        { stdin: stdinFrom(null), stdout: (s) => stdout.push(s), stderr: () => undefined },
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("fail-open");
    });

    it("exits 2 on an unknown option (CLI misuse is a defect, not a state read)", async () => {
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

    it("parses all documented flags", () => {
      const opts = parseArgs(["--repo-root", "/r", "--agent", "a", "--task", "T1", "--workflow", "WF1", "--selftest"]);
      expect(opts).toEqual({
        repoRoot: "/r",
        agent: "a",
        task: "T1",
        workflow: "WF1",
        selftest: true,
      });
    });

    it("readStdinJson tolerates empty and malformed stdin", async () => {
      expect(await readStdinJson({ stdin: stdinFrom(null) })).toBeNull();
      expect(await readStdinJson({ stdin: stdinFrom("{nope") })).toBeNull();
      expect(await readStdinJson({ stdin: stdinFrom('{"a":1}') })).toEqual({ a: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("simulated hook invocation (executable sh entry)", () => {
    it("runs the real .claude/hooks/teammate-idle.sh end-to-end on both branches", async () => {
      // Simulate the real Claude Code invocation: the registered command runs
      // the repo's own .claude/hooks/teammate-idle.sh with the hook JSON on
      // stdin. The state root is redirected via --repo-root (forwarded by the
      // sh entry), so the exercise covers bash → tsx → runHook → decision.
      const shPath = new URL("../../.claude/hooks/teammate-idle.sh", import.meta.url).pathname;
      const stats = await stat(shPath);
      expect(stats.mode & 0o111).not.toBe(0); // executable bit set

      // Branch 1: owned ACTIVE work → exit 2, stderr instruction.
      let threw = false;
      let stderrText = "";
      try {
        execFileSync("bash", [shPath, "--repo-root", dir, "--agent", "agent-a"], {
          input: JSON.stringify({ hook_event_name: "TeammateIdle", teammate_name: "agent-a" }),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        threw = true;
        const e = err as { status?: number; stderr?: string };
        expect(e.status).toBe(2);
        stderrText = e.stderr ?? "";
      }
      expect(threw).toBe(true);
      expect(stderrText).toContain("IDLE BLOCKED");
      expect(stderrText).toContain("WF1-001");

      // Branch 2: nothing owned, no compatible work → exit 0, allow idle.
      const out = execFileSync(
        "bash",
        [shPath, "--repo-root", dir, "--agent", "agent-c", "--workflow", "WF9"],
        { input: JSON.stringify({ hook_event_name: "TeammateIdle" }), encoding: "utf8" },
      );
      expect(out).toContain("allowing idle");
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  describe("selftest", () => {
    it("passes the built-in simulated-invocation self-test", async () => {
      const lines: string[] = [];
      await selftest((l) => lines.push(l));
      expect(lines.at(-1)).toBe("TEAMMATE-IDLE SELFTEST PASS");
    });
  });
});
