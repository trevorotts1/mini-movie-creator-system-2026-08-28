import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BatchMergeEngine,
  RealGitAdapter,
  type RegressionRunner,
} from "./batch-merge.js";
import type { QcEvidence } from "./batch-merge.js";

// ---------------------------------------------------------------------------
// Fixture repo builder — a real git repo with integration + task branches
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-bm-"));
  tempDirs.push(dir);
  const g = (...args: string[]) => sh(dir, ...args);
  g("init", "-q", "-b", "integration");
  g("config", "user.email", "fixture@mmcs.test");
  g("config", "user.name", "Fixture");
  g("commit", "--allow-empty", "-m", "seed");
  return dir;
}

/** Delegate every method of a RealGitAdapter while overriding a few. */
function withOverrides(
  base: RealGitAdapter,
  overrides: Partial<Record<string, unknown>>,
): RealGitAdapter {
  const proto = Object.getPrototypeOf(base) as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  // Class prototype methods are non-enumerable — use getOwnPropertyNames.
  for (const key of Object.getOwnPropertyNames(proto)) {
    const fn = proto[key];
    if (typeof fn === "function") obj[key] = (fn as (...a: unknown[]) => unknown).bind(base);
  }
  for (const [k, v] of Object.entries(overrides)) obj[k] = v;
  return obj as unknown as RealGitAdapter;
}

function commitFile(
  repo: string,
  branch: string,
  file: string,
  content: string,
  message: string,
): string {
  const g = (...args: string[]) => sh(repo, ...args);
  const branches = g("branch", "--list", branch);
  if (branches.trim() === "") {
    g("checkout", "-q", "-b", branch);
  } else {
    g("checkout", "-q", branch);
  }
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  g("add", file);
  g("commit", "-q", "-m", message);
  const sha = g("rev-parse", "HEAD");
  g("checkout", "-q", "integration");
  return sha;
}

function writeJson(repo: string, rel: string, value: unknown): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}

function writeQc(repo: string, taskId: string, qc: QcEvidence): void {
  writeJson(repo, `state/task-updates/${taskId}.qc.json`, qc);
}

function passQc(taskId: string, commit: string): QcEvidence {
  return {
    taskId,
    phase: "PASS",
    commit,
    checksRun: "fixture vitest",
    defectsFound: 0,
    defectsFixed: 0,
    finalTestResult: "PASS",
    qcAgent: "qc-batch",
    blockers: [],
  };
}

function okRunner(): RegressionRunner {
  return { run: async () => ({ ok: true, output: "fixture: all green" }) };
}

const fixedNow = () => new Date("2026-08-28T16:00:00.000Z");

async function head(repo: string, ref = "integration"): Promise<string | null> {
  const git = new RealGitAdapter(repo, fixedNow);
  return git.revParse(ref);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchMergeEngine on fixture git repos", () => {
  it("dry-run: admits, orders, plans — mutates nothing (acceptance)", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "pkgA/a.ts", "export const a=1;\n", "A work");
    const b = commitFile(repo, "task/B-beta", "pkgB/b.ts", "export const b=2;\n", "B work");

    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }, { taskId: "B", branch: "task/B-beta" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [
        { id: "A", branch: "task/A-alpha", status: "PASS" },
        { id: "B", branch: "task/B-beta", status: "PASS" },
      ],
    });
    writeQc(repo, "A", passQc("A", a));
    writeQc(repo, "B", passQc("B", b));

    const pre = await head(repo);
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      dryRun: true,
      push: false,
      regression: okRunner(),
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();

    expect(report.dryRun).toBe(true);
    expect(report.lockAcquired).toBe(true);
    expect(report.candidates.sort()).toEqual(["A", "B"]);
    expect(report.rejected).toEqual([]);
    expect(report.ordered.sort()).toEqual(["A", "B"]);
    expect(report.conflicts).toEqual([]);
    expect(report.merged).toEqual([]); // no merge attempts in dry-run
    expect(report.notes.some((n) => n.startsWith("dry-run"))).toBe(true);
    expect(await head(repo)).toBe(pre); // integration unmoved
    // queue + tasks.json untouched
    const mqAfter = JSON.parse(fs.readFileSync(path.join(repo, "state/merge-queue.json"), "utf8"));
    expect(mqAfter.items).toHaveLength(2);
    const tasksAfter = JSON.parse(fs.readFileSync(path.join(repo, "state/tasks.json"), "utf8"));
    expect(tasksAfter.items.find((t: { id: string }) => t.id === "A").status).toBe("PASS");
    expect(fs.existsSync(path.join(repo, "logs/merges"))).toBe(false); // no evidence writes
  });

  it("batch-merges two PASS items, marks MERGED, drains queue, writes evidence + ledger", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "packages/core/src/a.ts", "export const a=1;\n", "A work");
    const b = commitFile(repo, "task/B-beta", "packages/database/src/b.ts", "export const b=2;\n", "B work");

    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }, { taskId: "B", branch: "task/B-beta" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [
        { id: "A", branch: "task/A-alpha", status: "PASS" },
        { id: "B", branch: "task/B-beta", status: "PASS" },
      ],
    });
    writeQc(repo, "A", passQc("A", a));
    writeQc(repo, "B", passQc("B", b));

    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();

    expect(report.rejected).toEqual([]);
    expect(report.ordered.sort()).toEqual(["A", "B"]);
    const mergedIds = report.merged.filter((m) => m.status === "MERGED").map((m) => m.taskId);
    expect(mergedIds.sort()).toEqual(["A", "B"]);
    expect(report.batchMergedSha).not.toBeNull();
    expect(report.regression?.ok).toBe(true);
    expect(report.regression?.affectedAreas.sort()).toEqual(["packages/core", "packages/database"]);
    expect(report.pushed).toBe(false); // push disabled by config
    expect(report.queueAfter).toEqual([]);
    expect(report.evidencePath).toBeTruthy();
    expect(fs.existsSync(report.evidencePath as string)).toBe(true);
    const ledger = fs.readFileSync(path.join(repo, "ledger.md"), "utf8");
    expect(ledger).toContain("| A | batch-merge | MERGED |");
    expect(ledger).toContain("REGRESSION | PASS");

    // control state flipped to MERGED
    const tasksAfter = JSON.parse(fs.readFileSync(path.join(repo, "state/tasks.json"), "utf8"));
    expect(tasksAfter.items.find((t: { id: string }) => t.id === "A").status).toBe("MERGED");
    expect(tasksAfter.items.find((t: { id: string }) => t.id === "B").status).toBe("MERGED");

    // merge commits are real two-parent merges on integration
    const shas = report.merged.map((m) => m.mergeSha as string);
    for (const sha of shas) {
      const parents = sh(repo, "rev-list", "--parents", "-n", "1", sha).split(/\s+/);
      expect(parents).toHaveLength(3);
    }
    expect(await head(repo)).toBe(report.batchMergedSha);
  });

  it("ignores a queue entry with no QC PASS (no QC PASS = no merge)", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "packages/core/src/a.ts", "a\n", "A work");

    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [{ id: "A", branch: "task/A-alpha", status: "BUILDER_DONE" }],
    });
    // No qc.json at all for A.

    const pre = await head(repo);
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();

    expect(report.candidates).toEqual(["A"]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.reason).toBe("NO_QC_PASS");
    expect(report.ordered).toEqual([]);
    expect(await head(repo)).toBe(pre); // nothing merged
    const mq = JSON.parse(fs.readFileSync(path.join(repo, "state/merge-queue.json"), "utf8"));
    expect(mq.items).toHaveLength(1); // queue not drained
  });

  it("conflicted item is left for resolvers while the clean item merges", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "shared/one.txt", "from A\n", "A shared");
    const b = commitFile(repo, "task/B-beta", "shared/one.txt", "from B\n", "B shared");

    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }, { taskId: "B", branch: "task/B-beta" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [
        { id: "A", branch: "task/A-alpha", status: "PASS" },
        { id: "B", branch: "task/B-beta", status: "PASS" },
      ],
    });
    writeQc(repo, "A", passQc("A", a));
    writeQc(repo, "B", passQc("B", b));

    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.taskId).toBe("B");
    expect(report.conflicts[0]?.files).toContain("shared/one.txt");
    const merged = report.merged.filter((m) => m.status === "MERGED").map((m) => m.taskId);
    expect(merged).toEqual(["A"]);
    const conflicted = report.merged.find((m) => m.taskId === "B");
    expect(conflicted?.status).toBe("CONFLICT");
    // A still landed despite B's conflict.
    expect(await head(repo)).toBe(report.batchMergedSha);
    expect(report.queueAfter).toEqual(["B"]);
  });

  it("regression failure reverts the whole batch and isolates the culprit", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "packages/core/src/a.ts", "a\n", "A work");
    const b = commitFile(repo, "task/B-beta", "packages/core/src/b.ts", "b\n", "B work");

    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }, { taskId: "B", branch: "task/B-beta" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [
        { id: "A", branch: "task/A-alpha", status: "PASS" },
        { id: "B", branch: "task/B-beta", status: "PASS" },
      ],
    });
    writeQc(repo, "A", passQc("A", a));
    writeQc(repo, "B", passQc("B", b));

    const pre = await head(repo);
    // Call order: batch regression (fail) → culprit isolation A (pass) → B (fail).
    let calls = 0;
    const runner: RegressionRunner = {
      run: async () => {
        calls += 1;
        // calls: 1 = batch, 2 = isolation A, 3 = isolation B
        return { ok: calls !== 1 && calls !== 3, output: `call ${calls}` };
      },
    };
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: runner,
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();

    expect(report.regression?.ok).toBe(false);
    expect(report.reverted).toBe(true);
    expect(await head(repo)).toBe(pre); // integration restored
    expect(report.culprits).toEqual(["B"]);
    // No control state was flipped for reverted items.
    const tasksAfter = JSON.parse(fs.readFileSync(path.join(repo, "state/tasks.json"), "utf8"));
    expect(tasksAfter.items.find((t: { id: string }) => t.id === "A").status).toBe("PASS");
    const mq = JSON.parse(fs.readFileSync(path.join(repo, "state/merge-queue.json"), "utf8"));
    expect(mq.items).toHaveLength(2);
  });

  it("holds the merge.lock during the cycle and removes it after", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "packages/core/src/a.ts", "a\n", "A work");
    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }],
      updated_at: "x",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [{ id: "A", branch: "task/A-alpha", status: "PASS" }],
    });
    writeQc(repo, "A", passQc("A", a));

    let lockSeenDuringCycle = false;
    const runner: RegressionRunner = {
      run: async () => {
        lockSeenDuringCycle = fs.existsSync(path.join(repo, "state/locks/merge.lock"));
        return { ok: true, output: "fixture" };
      },
    };
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: runner,
      git: new RealGitAdapter(repo, fixedNow),
    });
    await engine.run();
    expect(lockSeenDuringCycle).toBe(true);
    expect(fs.existsSync(path.join(repo, "state/locks/merge.lock"))).toBe(false);
  });

  it("refuses a second cycle while the first still holds the lock", async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "state/locks"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "state/locks/merge.lock"),
      JSON.stringify({ holder: "other-cycle", token: "foreign" }),
    );
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();
    expect(report.lockAcquired).toBe(false);
    expect(report.lockError).toMatch(/could not acquire/);
    expect(fs.existsSync(path.join(repo, "state/locks/merge.lock"))).toBe(true); // not clobbered
  });

  it("breaks a stale lock older than the staleness window and proceeds", async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "state/locks"), { recursive: true });
    const stalePath = path.join(repo, "state/locks/merge.lock");
    fs.writeFileSync(stalePath, JSON.stringify({ holder: "dead-cycle" }));
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(stalePath, old, old);

    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      git: new RealGitAdapter(repo, fixedNow),
      lockStaleMs: 15 * 60 * 1000,
    });
    const report = await engine.run();
    expect(report.lockAcquired).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it("secret scan blocks the batch and no push happens", async () => {
    const repo = makeRepo();
    // Land a secret-looking blob directly on the task branch.
    const leaked = commitFile(
      repo,
      "task/A-alpha",
      "packages/core/src/leak.ts",
      `export const K = "sk-ant-abcdefghijklmnop123";\n`,
      "oops",
    );
    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [{ id: "A", branch: "task/A-alpha", status: "PASS" }],
    });
    writeQc(repo, "A", passQc("A", leaked));

    // scanDiff is exercised directly here because the engine composes it into
    // the push gate; assert the engine's push gate refuses when the scan hits.
    const { scanDiff } = await import("./batch-merge.js");
    const git = new RealGitAdapter(repo, fixedNow);
    const pre = (await head(repo)) as string;
    const branchSha = (await head(repo, "task/A-alpha")) as string;
    const files = await git.diffPaths(pre, branchSha);
    const content = await git.diffContent(pre, branchSha);
    const verdict = scanDiff(content, files, (p) => null);
    expect(verdict.secrets.length).toBeGreaterThan(0);

    // The engine does not push when the scan verdict is dirty (unit-level gate
    // check against the real adapter path).
    let pushCalls = 0;
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: true,
      regression: okRunner(),
      now: fixedNow,
      git: withOverrides(new RealGitAdapter(repo, fixedNow), {
        push: async () => {
          pushCalls += 1;
        },
        hasOrigin: async () => true,
      }),
    });
    const report = await engine.run();
    // Engine merges (scan verdict computed in-test), but push gate is the
    // acceptance path — with the fixture merge clean, the cycle must not have
    // pushed a dirty diff.
    expect(pushCalls).toBe(0);
    expect(report.pushed).toBe(false);
  });

  it("integration-queue.md MERGED rows are re-admission-blocked (ALREADY_MERGED)", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "pkg/a.ts", "a\n", "A work");
    const b = commitFile(repo, "task/B-beta", "pkg/b.ts", "b\n", "B work");
    fs.writeFileSync(
      path.join(repo, "integration-queue.md"),
      [
        "# Integration Queue",
        "",
        "| Queue ID | Task ID | Branch / Worktree | Builder | Checker | QC Verdict | Target Branch | Status | Landed SHA |",
        "|---|---|---|---|---|---|---|---|---|",
        `| IQ-001 | A | task/A-alpha | CORE | Sonnet | PASS | integration | MERGED | ${a} |`,
        `| IQ-002 | B | task/B-beta | CORE | Sonnet | PASS | integration | READY_TO_MERGE | Pending |`,
      ].join("\n"),
    );
    writeJson(repo, "state/merge-queue.json", { schema_version: 1, items: [], updated_at: "x" });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [{ id: "B", branch: "task/B-beta", status: "PASS" }],
    });
    writeQc(repo, "B", passQc("B", b));

    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: false,
      regression: okRunner(),
      now: fixedNow,
      git: new RealGitAdapter(repo, fixedNow),
    });
    const report = await engine.run();
    // A appears in queue-md but is MERGED — it never becomes a candidate.
    expect(report.candidates).toEqual(["B"]);
    expect(report.ordered).toEqual(["B"]);
  });

  it("pushes to origin only after green regression", async () => {
    const repo = makeRepo();
    const a = commitFile(repo, "task/A-alpha", "packages/core/src/a.ts", "a\n", "A work");
    writeJson(repo, "state/merge-queue.json", {
      schema_version: 1,
      items: [{ taskId: "A", branch: "task/A-alpha" }],
      updated_at: "2026-08-28T00:00:00Z",
    });
    writeJson(repo, "state/tasks.json", {
      schema_version: 1,
      items: [{ id: "A", branch: "task/A-alpha", status: "PASS" }],
    });
    writeQc(repo, "A", passQc("A", a));

    let pushCalls = 0;
    const engine = new BatchMergeEngine({
      repoRoot: repo,
      push: true,
      regression: okRunner(),
      now: fixedNow,
      git: withOverrides(new RealGitAdapter(repo, fixedNow), {
        push: async (ref: string) => {
          pushCalls += 1;
          expect(ref).toBe("integration");
        },
        hasOrigin: async () => true,
      }),
    });
    const report = await engine.run();
    expect(report.regression?.ok).toBe(true);
    expect(pushCalls).toBe(1);
    expect(report.pushed).toBe(true);
  });
});