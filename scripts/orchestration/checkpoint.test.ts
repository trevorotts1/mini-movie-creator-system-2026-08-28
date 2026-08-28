/// <reference types="node" />
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CADENCE_EVENTS,
  CheckpointLockError,
  CheckpointWiring,
  STATUS_TO_BUCKET,
  describeCadence,
  isCadenceEvent,
  parseArgs,
  runCli,
  selftest,
  withCheckpointLock,
} from "./checkpoint.js";
import { CHECKPOINT_FILE } from "../../packages/core/src/recovery/index.js";

describe("checkpoint wiring (REC-001)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmcs-rec001-test-"));
    await mkdir(join(dir, "state"), { recursive: true });
    await mkdir(join(dir, "state", "locks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readCheckpoint = async () =>
    JSON.parse(
      await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8"),
    ) as Record<string, unknown>;

  describe("cadence contract (spec §28)", () => {
    it("covers every spec §28 event", () => {
      const required = [
        "material-transition",
        "pre-compact",
        "post-compact",
        "pre-batch-merge",
        "post-batch-merge",
        "pre-restart",
        "session-end",
        "after-recovery",
        "watchdog-cycle",
      ] as const;
      for (const event of required) {
        expect(CADENCE_EVENTS).toContain(event);
        expect(isCadenceEvent(event)).toBe(true);
      }
      expect(describeCadence()).toHaveLength(CADENCE_EVENTS.length);
    });

    it("rejects unknown events", () => {
      expect(isCadenceEvent("mid-compact")).toBe(false);
      expect(isCadenceEvent(42)).toBe(false);
      expect(isCadenceEvent(null)).toBe(false);
    });

    it("every event writes a valid checkpoint document", async () => {
      const wiring = new CheckpointWiring(dir);
      await wiring.preCompact(["a"]);
      expect((await readCheckpoint()).nextActions).toEqual(["a"]);
      await wiring.materialTransition("T1", "ready");
      await wiring.materialTransition("T1", "active");
      await wiring.preBatchMerge("f".repeat(40));
      await wiring.postBatchMerge("e".repeat(40), "d".repeat(40));
      await wiring.watchdogCycle({ nextActions: ["w"], workflowIds: ["WF10"], agentIds: ["A1"] });
      await wiring.sessionEnd(["end"]);
      await wiring.afterRecovery(["rec"]);
      await wiring.preRestart(["restart"]);
      await wiring.postCompact(["post"]);

      const doc = await readCheckpoint();
      expect(doc.readyTaskIds).toEqual([]);
      expect(doc.activeTaskIds).toEqual(["T1"]);
      expect(doc.qcTaskIds).toEqual([]);
      expect(doc.currentIntegrationSha).toBe("d".repeat(40));
      expect(doc.lastKnownGoodCommit).toBe("e".repeat(40));
      expect(doc.activeWorkflowIds).toEqual(["WF10"]);
      expect(doc.activeAgentIds).toEqual(["A1"]);
      expect(typeof doc.lastWatchdogAt).toBe("string");
      expect(typeof doc.lastMergeAt).toBe("string");
      expect(doc.nextActions).toEqual(["post"]);
      // The file must be complete, parseable JSON with the trailing newline
      // written by the atomic writer.
      const raw = await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.startsWith("{")).toBe(true);
    });
  });

  describe("material transitions", () => {
    it("checkpoints on every transition and moves tasks between buckets disjointly", async () => {
      const wiring = new CheckpointWiring(dir);
      await wiring.materialTransition("T1", "ready");
      expect((await readCheckpoint()).readyTaskIds).toEqual(["T1"]);

      await wiring.materialTransition("T1", "active");
      const afterActive = await readCheckpoint();
      expect(afterActive.activeTaskIds).toEqual(["T1"]);
      expect(afterActive.readyTaskIds).toEqual([]);

      await wiring.materialTransition("T1", "qc");
      await wiring.materialTransition("T1", "mergeQueue");
      expect((await readCheckpoint()).mergeQueueTaskIds).toEqual(["T1"]);

      await wiring.materialTransition("T1", null);
      const doc = await readCheckpoint();
      for (const key of ["readyTaskIds", "activeTaskIds", "qcTaskIds", "blockedTaskIds", "mergeQueueTaskIds"]) {
        expect(doc[key]).toEqual([]);
      }
      // One journal entry per write, all triggered by the cadence event.
      const journal = wiring.getJournal();
      expect(journal.length).toBe(5);
      expect(journal.every((entry) => entry.trigger === "material-transition")).toBe(true);
    });

    it("journals each cadence write with its trigger", async () => {
      const wiring = new CheckpointWiring(dir);
      await wiring.preCompact();
      await wiring.watchdogCycle();
      const journal = wiring.getJournal();
      expect(journal.map((e) => e.trigger)).toEqual(["pre-compact", "watchdog-cycle"]);
      expect(journal[0]?.at).toBeTruthy();
    });

    it("rejects empty task ids", async () => {
      const wiring = new CheckpointWiring(dir);
      await expect(wiring.materialTransition("", "ready")).rejects.toThrow(/taskId/);
      await expect(wiring.materialTransition("   ", "ready")).rejects.toThrow(/taskId/);
    });

    it("rejects an empty repoRoot", () => {
      expect(() => new CheckpointWiring("")).toThrow(/repoRoot/);
    });
  });

  describe("atomic write under concurrent writers", () => {
    it("survives 20 concurrent in-process writers with no lost update", async () => {
      const wiring = new CheckpointWiring(dir);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          wiring.materialTransition(`T-${i}`, i % 2 === 0 ? "ready" : "active"),
        ),
      );
      const doc = await readCheckpoint();
      const ready = doc.readyTaskIds as string[];
      const active = doc.activeTaskIds as string[];
      for (let i = 0; i < 20; i += 1) {
        const id = `T-${i}`;
        expect(ready.includes(id) || active.includes(id)).toBe(true);
      }
      expect(ready.length).toBe(10);
      expect(active.length).toBe(10);
    });

    it("cross-process writers serialize through the checkpoint lock (no lost update)", async () => {
      // Each writer is an independent OS process that re-reads disk inside the
      // lock and appends its id — the exact cross-process race the in-process
      // write queue cannot protect against. The runner is tsx (Node 26
      // --experimental-strip-types does not resolve .js → .ts specifiers).
      const scriptPath = join(dir, "writer.mts");
      const wiringModuleUrl = new URL("./checkpoint.ts", import.meta.url).pathname;
      await writeFile(
        scriptPath,
        `
        import { CheckpointWiring } from ${JSON.stringify(wiringModuleUrl)};
        const id = process.argv[2];
        const root = process.argv[3];
        const wiring = new CheckpointWiring(root);
        await wiring.write("material-transition", (state) => {
          state.nextActions = [...state.nextActions, id];
        });
        process.stdout.write("ok:" + id);
        `,
        "utf8",
      );
      const { execFile, execFileSync } = await import("node:child_process");
      // Resolve tsx CLI dynamically or fall back to npx
      let tsxCli = "";
      try {
        const out = execFileSync("npx", ["which", "tsx"], { encoding: "utf8" }).trim();
        if (out) tsxCli = out;
      } catch {
        // search npx cache
        const glob = join(process.env.HOME ?? "", ".npm", "_npx", "fd45a72a545557e9", "node_modules", "tsx", "dist", "cli.mjs");
        tsxCli = glob;
      }
      const run = (id: string) =>
        new Promise<string>((resolve) => {
          if (tsxCli && !tsxCli.endsWith(".mjs")) {
            execFile(
              tsxCli,
              [scriptPath, id, dir],
              { timeout: 90_000 },
              (err, stdout, stderr) => (err ? resolve(`ERR:${stderr}`) : resolve(stdout)),
            );
          } else if (tsxCli) {
            execFile(
              process.execPath,
              [tsxCli, scriptPath, id, dir],
              { timeout: 90_000 },
              (err, stdout, stderr) => (err ? resolve(`ERR:${stderr}`) : resolve(stdout)),
            );
          } else {
            execFile(
              "npx",
              ["tsx", scriptPath, id, dir],
              { timeout: 90_000 },
              (err, stdout, stderr) => (err ? resolve(`ERR:${stderr}`) : resolve(stdout)),
            );
          }
        });
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => run(`P${i}`)));
      for (const r of results) expect(r.startsWith("ok:")).toBe(true);

      const doc = await readCheckpoint();
      const ids = doc.nextActions as string[];
      for (let i = 0; i < 6; i += 1) {
        expect(ids).toContain(`P${i}`);
      }
      expect(ids.length).toBe(6);
    }, 150_000);

    it("concurrent readers never observe a partial checkpoint file", async () => {
      const wiring = new CheckpointWiring(dir);
      await wiring.preCompact();
      let parses = 0;
      let missing = 0;
      const reader = async () => {
        for (let i = 0; i < 40; i += 1) {
          try {
            const raw = await readFile(join(dir, "state", CHECKPOINT_FILE), "utf8");
            JSON.parse(raw);
            parses += 1;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              missing += 1;
              continue;
            }
            throw err;
          }
        }
      };
      await Promise.all([
        reader(),
        wiring.materialTransition("R1", "ready"),
        wiring.materialTransition("R2", "active"),
        wiring.watchdogCycle(),
      ]);
      expect(parses).toBeGreaterThan(0);
      expect(missing).toBeLessThan(40);
    });

    it("lock acquisition conflicts surface as CheckpointLockError", async () => {
      const first = await withCheckpointLock(dir, async () => {
        // Nested acquisition against a live holder must fail fast (1s
        // timeout) instead of hanging on the held lock file.
        const wiring = new CheckpointWiring(dir, {
          lockOptions: { timeoutMs: 1_000 },
        });
        await expect(wiring.materialTransition("X", "ready")).rejects.toThrow(
          CheckpointLockError,
        );
        return "held";
      });
      expect(first).toBe("held");
      // Lock is released afterwards: a normal write succeeds.
      const wiring = new CheckpointWiring(dir);
      await wiring.materialTransition("X", "ready");
      expect((await readCheckpoint()).readyTaskIds).toContain("X");
    }, 60_000);
  });

  describe("state/ writers reconciliation", () => {
    it("maps tasks.json statuses to checkpoint buckets", () => {
      expect(STATUS_TO_BUCKET.READY).toBe("ready");
      expect(STATUS_TO_BUCKET.ACTIVE).toBe("active");
      expect(STATUS_TO_BUCKET.QC_FIXING).toBe("active");
      expect(STATUS_TO_BUCKET.BUILDER_DONE).toBe("qc");
      expect(STATUS_TO_BUCKET.PASS).toBe("mergeQueue");
      expect(STATUS_TO_BUCKET.BLOCKED).toBe("blocked");
      expect(STATUS_TO_BUCKET.MERGED).toBeNull();
      // Unknown status → undefined → unmapped.
      expect(STATUS_TO_BUCKET.WEIRD).toBeUndefined();
    });

    it("syncFromTasks rebuilds all buckets and reports unmapped ids", async () => {
      const wiring = new CheckpointWiring(dir);
      const tasks = [
        { id: "T-R", status: "READY" },
        { id: "T-A", status: "ACTIVE" },
        { id: "T-F", status: "QC_FIXING" },
        { id: "T-Q", status: "BUILDER_DONE" },
        { id: "T-P", status: "PASS" },
        { id: "T-B", status: "BLOCKED" },
        { id: "T-M", status: "MERGED" },
        { id: "T-X", status: "WEIRD" },
      ];
      const { state, unmapped } = await wiring.syncFromTasks(tasks);
      expect(state.readyTaskIds).toEqual(["T-R"]);
      expect(state.activeTaskIds).toEqual(["T-A", "T-F"]);
      expect(state.qcTaskIds).toEqual(["T-Q"]);
      expect(state.mergeQueueTaskIds).toEqual(["T-P"]);
      expect(state.blockedTaskIds).toEqual(["T-B"]);
      expect(unmapped).toEqual(["T-X"]);
      const doc = await readCheckpoint();
      expect(doc.qcTaskIds).toEqual(["T-Q"]);
    });

    it("drops ids that no longer exist in tasks.json", async () => {
      const wiring = new CheckpointWiring(dir);
      await wiring.materialTransition("GONE", "ready");
      expect((await readCheckpoint()).readyTaskIds).toEqual(["GONE"]);
      await wiring.syncFromTasks([{ id: "NEW", status: "READY" }]);
      const doc = await readCheckpoint();
      expect(doc.readyTaskIds).toEqual(["NEW"]);
      expect(doc.readyTaskIds).not.toContain("GONE");
    });
  });

  describe("stale lock takeover", () => {
    const backdate = async (lockPath: string) => {
      const old = new Date(Date.now() - 10 * 60_000);
      await utimes(lockPath, old, old);
    };

    it("takes over a lock left by a dead writer (stale mtime)", async () => {
      const lockPath = join(dir, "state", "locks", "checkpoint.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: -999,
          at: new Date(Date.now() - 10 * 60_000).toISOString(),
        })}\n`,
        "utf8",
      );
      await backdate(lockPath);
      const wiring = new CheckpointWiring(dir);
      await wiring.preCompact(["took-over"]);
      expect((await readCheckpoint()).nextActions).toEqual(["took-over"]);
    });

    it("unparseable stale lock litter is taken over too", async () => {
      const lockPath = join(dir, "state", "locks", "checkpoint.lock");
      await writeFile(lockPath, "not-json-at-all", "utf8");
      await backdate(lockPath);
      const wiring = new CheckpointWiring(dir);
      await wiring.preCompact(["litter-cleared"]);
      expect((await readCheckpoint()).nextActions).toEqual(["litter-cleared"]);
    });

    it("a fresh empty lock file (writer mid-create) is waited on, not stolen", async () => {
      const lockPath = join(dir, "state", "locks", "checkpoint.lock");
      await writeFile(lockPath, "", "utf8"); // fresh, not backdated
      const wiring = new CheckpointWiring(dir, { lockOptions: { timeoutMs: 500 } });
      await expect(wiring.preCompact(["too-eager"])).rejects.toThrow(CheckpointLockError);
    });
  });

  describe("CLI", () => {
    it("parses arguments", () => {
      const opts = parseArgs([
        "--event",
        "watchdog-cycle",
        "--next-actions",
        "a, b ,c",
        "--repo-root",
        "/x",
        "--selftest",
      ]);
      expect(opts.event).toBe("watchdog-cycle");
      expect(opts.nextActions).toEqual(["a", "b", "c"]);
      expect(opts.repoRoot).toBe("/x");
      expect(opts.selftest).toBe(true);
    });

    it("rejects unknown options and missing values with exit 2", async () => {
      const stderr: string[] = [];
      const code = await runCli(["--bogus"], {
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("unknown option");

      const code2 = await runCli(["--event"], {
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code2).toBe(2);
    });

    it("exits 0 on --help", async () => {
      const out: string[] = [];
      const code = await runCli(["--help"], {
        stdout: (s) => out.push(s),
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      expect(out.join("")).toContain("--event");
    });

    it("material-transition CLI writes a checkpoint", async () => {
      const out: string[] = [];
      const code = await runCli(
        ["--event", "material-transition", "--task", "CLI-1", "--bucket", "ready", "--repo-root", dir],
        { stdout: (s) => out.push(s), stderr: () => undefined },
      );
      expect(code).toBe(0);
      expect((await readCheckpoint()).readyTaskIds).toEqual(["CLI-1"]);
    });

    it("CLI --sync reconciles from state/tasks.json", async () => {
      await writeFile(
        join(dir, "state", "tasks.json"),
        JSON.stringify({
          schema_version: 1,
          items: [
            { id: "S1", status: "ACTIVE" },
            { id: "S2", status: "READY" },
          ],
        }),
        "utf8",
      );
      const out: string[] = [];
      const code = await runCli(["--sync", "--repo-root", dir], {
        stdout: (s) => out.push(s),
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      const doc = await readCheckpoint();
      expect(doc.activeTaskIds).toEqual(["S1"]);
      expect(doc.readyTaskIds).toEqual(["S2"]);
      expect(out.join("")).toContain("synced buckets");
    });

    it("rejects an invalid --event value with exit 2", async () => {
      const stderr: string[] = [];
      const code = await runCli(["--event", "whenever"], {
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("must be one of");
    });

    it("exits 2 when there is nothing to do", async () => {
      const stderr: string[] = [];
      const code = await runCli(["--repo-root", dir], {
        stdout: () => undefined,
        stderr: (s) => stderr.push(s),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toContain("nothing to do");
    });
  });

  describe("selftest", () => {
    it("passes end-to-end on a temp repo root", async () => {
      const lines: string[] = [];
      await selftest((line) => lines.push(line));
      const out = lines.join("\n");
      expect(out).toContain("concurrent-writers");
      expect(out).toContain("cadence: all spec §28 events persisted");
      expect(out).toContain("atomicity: concurrent reads all parsed complete checkpoints");
      expect(out).toContain("CHECKPOINT SELFTEST PASS");
    });
  });
});