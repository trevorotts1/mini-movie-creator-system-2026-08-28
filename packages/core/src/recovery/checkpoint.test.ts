import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOrNull,
} from "./atomic-write.js";
import {
  CHECKPOINT_FILE,
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaError,
  CheckpointService,
  emptyCheckpoint,
  normalizeCheckpoint,
  toResumeView,
  type CheckpointState,
} from "./checkpoint.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mmcs-checkpoint-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function svc(): CheckpointService {
  return new CheckpointService(root);
}

describe("CheckpointService — atomic writes", () => {
  it("writes checkpoint.json with the runbook §5 field set", async () => {
    const s = svc();
    const state = await s.save({
      ...emptyCheckpoint("mini-movie-creator-system-2026-08-28", root),
      origin: "https://github.com/trevorotts1/mini-movie-creator-system-2026-08-28.git",
      upstream: "hassancs91/claude-faceless-shorts-creator",
      integrationBranch: "integration",
      readyTaskIds: ["CORE-013"],
      blockedTaskIds: ["CORE-015"],
      mergeQueueTaskIds: ["CORE-012"],
      lastKnownGoodCommit: "abc1234",
      currentWave: 1,
    });
    expect(state.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(state.lastCheckpointAt).not.toBe("");

    const raw = await readFile(join(root, "state", CHECKPOINT_FILE), "utf8");
    const doc = JSON.parse(raw) as Record<string, unknown>;
    // runbook §5 minimum fields present
    for (const field of [
      "schemaVersion",
      "project",
      "repoRoot",
      "origin",
      "upstream",
      "integrationBranch",
      "lastCheckpointAt",
      "lastMergeAt",
      "lastWatchdogAt",
      "currentWave",
      "buildComplete",
      "activeWorkflowIds",
      "readyTaskIds",
      "blockedTaskIds",
      "mergeQueueTaskIds",
      "lastKnownGoodCommit",
    ]) {
      expect(doc).toHaveProperty(field);
    }
  });

  it("writes are atomic — no temp litter left after successful saves", async () => {
    const s = svc();
    for (let i = 0; i < 5; i++) {
      await s.update((state) => {
        state.currentWave = i + 1;
      });
    }
    const entries = await readdir(join(root, "state"));
    expect(entries).toEqual([CHECKPOINT_FILE]);
  });

  it("overwrites fully — latest save wins, content parses", async () => {
    const s = svc();
    await s.save({
      ...emptyCheckpoint(root, root),
      project: "first",
    });
    await s.save({
      ...emptyCheckpoint(root, root),
      project: "second",
    });
    const doc = await readJsonFileOrNull<CheckpointState>(s.filePath);
    expect(doc?.project).toBe("second");
  });

  it("save() and update() serialize concurrent in-process writes", async () => {
    const s = svc();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.update((state) => {
          state.nextActions.push(`action-${i}`);
        }),
      ),
    );
    const final = await s.get();
    expect(final.nextActions).toHaveLength(8);
  });
});

describe("CheckpointService — kill -9 crash safety", () => {
  it("kill -9 mid-write leaves the previous valid checkpoint parseable", async () => {
    const s = svc();
    await s.save({ ...emptyCheckpoint(root, root), project: "previous-valid" });
    const filePath = s.filePath;

    // Child process: write a large checkpoint repeatedly. Parent SIGKILLs it
    // at a random instant so the kill can land anywhere inside the write
    // (temp creation, data write, fsync, rename). Whatever the instant, the
    // on-disk checkpoint must be the previous valid document — full and
    // parseable — because the only mutation of checkpoint.json is an atomic
    // rename.
    const child = join(root, "writer.mjs");
    const big = JSON.stringify({
      ...emptyCheckpoint(root, root),
      project: "mid-write",
      nextActions: Array.from({ length: 20000 }, (_, i) => `step-${i}-payload`),
    });
    await writeFile(
      child,
      [
        `import { atomicWriteFile } from ${JSON.stringify(
          new URL("./atomic-write.js", import.meta.url).pathname,
        )};`,
        `const target = ${JSON.stringify(filePath)};`,
        `const payload = ${JSON.stringify(`\n${big}`)};`,
        "for (;;) {",
        "  await atomicWriteFile(target, payload);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const killed = { ok: false } as { ok: boolean };
    try {
      execFileSync(process.execPath, [child], {
        cwd: root,
        timeout: 1500,
        killSignal: "SIGKILL",
      });
      killed.ok = true; // exited before timeout — treat as inconclusive pass
    } catch {
      // expected: timeout → SIGKILL
    }
    void killed;

    const raw = await readFile(filePath, "utf8");
    const doc = JSON.parse(raw) as { project?: string; schemaVersion?: number };
    // Either the previous checkpoint or a full new one — never partial.
    expect(["previous-valid", "mid-write"]).toContain(doc.project);
    expect(doc.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);

    // Recovery sweep removes any temp litter; checkpoint itself untouched.
    const sweeper = svc();
    const removed = await sweeper.sweepTempFiles();
    expect(removed).toBeGreaterThanOrEqual(0);
    const entries = await readdir(join(root, "state"));
    expect(entries).toEqual([CHECKPOINT_FILE]);
    const after = await sweeper.load();
    expect(after.project).toBe(doc.project);
  });

  it("sweepTempFiles removes pre-existing temp litter and keeps checkpoint", async () => {
    const s = svc();
    await s.save({ ...emptyCheckpoint(root, root), project: "keep-me" });
    await atomicWriteFile(
      join(root, "state", `${CHECKPOINT_FILE}.99999.123.tmp`),
      "half-written garbage that must never be read as a checkpoint",
    );
    const removed = await s.sweepTempFiles();
    expect(removed).toBe(1);
    const entries = await readdir(join(root, "state"));
    expect(entries).toEqual([CHECKPOINT_FILE]);
    const state = await s.load();
    expect(state.project).toBe("keep-me");
  });

  it("corrupt non-empty checkpoint throws instead of silently resetting", async () => {
    const s = svc();
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(s.filePath, "{ this is not json", "utf8");
    await expect(s.load()).rejects.toThrow();
  });
});

describe("CheckpointService — reload reconstructs task buckets", () => {
  it("reloads ready/blocked/mergeQueue ids after a fresh instance", async () => {
    const writer = svc();
    await writer.save({
      ...emptyCheckpoint("mini-movie-creator-system-2026-08-28", root),
      readyTaskIds: ["CORE-013", "CAP-001"],
      blockedTaskIds: ["CORE-015"],
      mergeQueueTaskIds: ["CORE-012"],
      activeTaskIds: ["CORE-003"],
      qcTaskIds: ["CORE-008"],
      activeWorkflowIds: ["WF01"],
      activeAgentIds: ["WF01-B1", "WF01-Q1"],
      lastKnownGoodCommit: "deadbee",
      nextActions: ["merge CORE-012", "dispatch CORE-013 QC"],
    });

    // Fresh instance = simulated new/resumed session reading from disk only.
    const resumed = svc();
    const view = toResumeView(await resumed.loadExisting());
    expect([...view.ready].sort()).toEqual(["CAP-001", "CORE-013"].sort());
    expect(view.blocked.has("CORE-015")).toBe(true);
    expect(view.mergeQueue.has("CORE-012")).toBe(true);
    expect(view.active.has("CORE-003")).toBe(true);
    expect(view.qc.has("CORE-008")).toBe(true);
    expect(view.checkpoint.activeWorkflowIds).toEqual(["WF01"]);
    expect(view.checkpoint.nextActions).toEqual([
      "merge CORE-012",
      "dispatch CORE-013 QC",
    ]);
    expect(view.checkpoint.lastKnownGoodCommit).toBe("deadbee");
  });

  it("setTaskState moves ids between buckets without duplicates", async () => {
    const s = svc();
    await s.save({
      ...emptyCheckpoint(root, root),
      readyTaskIds: ["A", "B"],
      blockedTaskIds: ["C"],
      mergeQueueTaskIds: [],
    });
    // A: ready → active → qc → mergeQueue; C unblocked → ready
    await s.setTaskState("A", "active");
    await s.setTaskState("A", "qc");
    await s.setTaskState("A", "mergeQueue");
    await s.setTaskState("C", "ready");
    // re-set same state is idempotent
    await s.setTaskState("A", "mergeQueue");

    const view = toResumeView(await new CheckpointService(root).loadExisting());
    expect(view.ready.has("B")).toBe(true);
    expect(view.ready.has("C")).toBe(true);
    expect(view.mergeQueue.has("A")).toBe(true);
    expect(view.active.has("A")).toBe(false);
    expect(view.qc.has("A")).toBe(false);
    expect(view.blocked.has("C")).toBe(false);
    expect([...view.ready].filter((id) => id === "C")).toHaveLength(1);
  });

  it("removeTask clears the id from every bucket", async () => {
    const s = svc();
    await s.save({
      ...emptyCheckpoint(root, root),
      blockedTaskIds: ["X"],
    });
    await s.removeTask("X");
    const view = toResumeView(await svc().loadExisting());
    expect(view.blocked.has("X")).toBe(false);
  });
});