// SKR-036 tests — scripts/release/task-ledger-verify.mjs
//
// Defect under test: `state/tasks.json` recorded a bare `"status": "MERGED"` per task
// with no evidence field (92 of 149 had none), 46 branch names that do not resolve, and
// CAP-009 recorded a rollback while still reading MERGED. "MERGED" was an assertion that
// nothing in the repo could confirm or refute.
//
// Strategy mirrors scripts/release/regression.test.ts: unit-test the exported pure
// helpers directly, then build a SANDBOX git repo in a temp dir with a COPY of the real
// script at the same relative path (the script anchors REPO to its own location, so
// sandbox runs must run the sandbox copy). Every sandbox test uses a real `git merge`,
// so attribution is exercised against the actual commit graph rather than a fixture.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { idMatcher, resolveOwnedPaths } from "./task-ledger-verify.mjs";

const REAL_SCRIPT = path.resolve(__dirname, "task-ledger-verify.mjs");
const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("idMatcher — bounded task-id tokens", () => {
  it("matches the id in the repo's real merge-subject convention", () => {
    expect(idMatcher("REC-011").test("merge: REC-011 auto-compact simulation (QC PASS 2 defects fixed)")).toBe(true);
    expect(idMatcher("CAP-009").test("merge: CAP-009 Provider health/verify")).toBe(true);
  });

  it("does NOT match a longer id that merely contains it", () => {
    // The whole point: REC-011 must not be credited with REC-0110's merge.
    expect(idMatcher("REC-011").test("merge: REC-0110 something else")).toBe(false);
    expect(idMatcher("CORE-01").test("merge: CORE-011 cli bootstrap")).toBe(false);
  });

  it("does not match an id embedded in an unrelated word", () => {
    expect(idMatcher("REC-011").test("merge: XREC-011foo")).toBe(false);
  });

  it("treats regex metacharacters in an id as literals", () => {
    expect(idMatcher("A.B-1").test("merge: A.B-1 done")).toBe(true);
    expect(idMatcher("A.B-1").test("merge: AXB-1 done")).toBe(false);
  });
});

describe("resolveOwnedPaths", () => {
  it("splits a comma list into repo-relative paths", () => {
    expect(resolveOwnedPaths("packages/a/, packages/b/").inRepo).toEqual(["packages/a", "packages/b"]);
  });

  it("expands a parenthetical file list against its parent directory", () => {
    const { inRepo } = resolveOwnedPaths(
      "skills/mini-movie-creator/ (SKILL.md, references/workflow.md, scripts/mmcs-status.sh)",
    );
    expect(inRepo).toContain("skills/mini-movie-creator");
    expect(inRepo).toContain("skills/mini-movie-creator/SKILL.md");
    expect(inRepo).toContain("skills/mini-movie-creator/references/workflow.md");
    expect(inRepo).toContain("skills/mini-movie-creator/scripts/mmcs-status.sh");
  });

  it("drops trailing prose from a path", () => {
    expect(resolveOwnedPaths("BASELINE-REPORT.md (append audit section)").inRepo).toEqual([
      "BASELINE-REPORT.md",
    ]);
  });

  it("reports $HOME and ~ references as outOfRepo rather than silently dropping them", () => {
    const { inRepo, outOfRepo } = resolveOwnedPaths(
      "integrations/claude/personal-install.sh, $HOME/.claude/skills/mini-movie-creator (symlink)",
    );
    expect(inRepo).toEqual(["integrations/claude/personal-install.sh"]);
    expect(outOfRepo.length).toBe(1);
  });

  it("returns nothing for an empty owns field", () => {
    expect(resolveOwnedPaths("")).toEqual({ inRepo: [], outOfRepo: [] });
    expect(resolveOwnedPaths(null)).toEqual({ inRepo: [], outOfRepo: [] });
  });
});

// ---------------------------------------------------------------------------
// sandbox harness
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/**
 * Build a sandbox repo: a merge commit whose subject names REC-011, an owned path that
 * exists at HEAD, and the task ledger. `omitOwnedPath` removes the owned path before the
 * merge so the MERGED claim cannot be substantiated.
 */
function sandbox(opts: { omitOwnedPath?: boolean; recordedSha?: string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-ledger-"));
  tmpRoots.push(dir);

  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");

  fs.mkdirSync(path.join(dir, "scripts", "release"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(dir, "scripts", "release", "task-ledger-verify.mjs"));

  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");

  git(dir, "checkout", "-q", "-b", "topic");
  if (!opts.omitOwnedPath) {
    fs.mkdirSync(path.join(dir, "packages", "demo"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "demo", "index.ts"), "export const x = 1;\n");
    git(dir, "add", "-A");
  }
  fs.writeFileSync(path.join(dir, "topic.txt"), "work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "REC-011: do the work");

  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "topic", "-m", "merge: REC-011 auto-compact simulation (QC PASS)");
  const mergeSha = git(dir, "rev-parse", "HEAD");

  const ledger = {
    schema_version: 1,
    updated_at: "2026-01-01T00:00:00Z",
    items: [
      {
        id: "REC-011",
        title: "auto-compact simulation",
        owns: "packages/demo/",
        branch: "task/REC-011-auto-compact",
        worktree: "worktrees/REC-011/",
        acceptance: "n/a",
        status: "MERGED",
        ...(opts.recordedSha === undefined
          ? {}
          : opts.recordedSha === null
            ? {}
            : { mergedSha: opts.recordedSha }),
      },
    ],
  };
  fs.writeFileSync(path.join(dir, "state", "tasks.json"), JSON.stringify(ledger, null, 1) + "\n");

  return { dir, mergeSha, ledgerPath: path.join(dir, "state", "tasks.json"), script: path.join(dir, "scripts", "release", "task-ledger-verify.mjs") };
}

function run(sandboxed: { script: string }, ...args: string[]) {
  try {
    const stdout = execFileSync("node", [sandboxed.script, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// ---------------------------------------------------------------------------
// end-to-end
// ---------------------------------------------------------------------------

describe("task-ledger-verify — end to end", () => {
  it("substantiates a MERGED claim that a merge commit + a present owned path support", () => {
    const s = sandbox();
    const r = run(s);
    expect(r.stdout).toContain("1/1 MERGED task(s) substantiated");
    expect(r.code).toBe(0);
  });

  it("FAILS when the owned path is absent at HEAD (work not actually merged)", () => {
    const s = sandbox({ omitOwnedPath: true });
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNSUBSTANTIATED_PATHS_ABSENT");
    expect(r.stderr).toContain("REC-011");
  });

  it("FAILS when no merge commit names the task (claim has no commit-graph support)", () => {
    const s = sandbox();
    // Rewrite the merge subject so the id no longer appears anywhere in history.
    git(s.dir, "commit", "-q", "--amend", "-m", "merge: unrelated work");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNSUBSTANTIATED_NO_MERGE");
  });

  it("prefers the canonical `merge: <ID>` subject over a passing mention of the id", () => {
    // 23 real tasks have more than one merge naming them, and several of those extra
    // mentions are of the form "Merge remote-tracking branch ... into task/<ID>-...",
    // which is about the branch, not the task landing. Picking the newest match would be
    // luck; the canonical `merge: <ID>` prefix is the repo's actual convention.
    const s = sandbox();
    // A later merge that merely mentions the id in passing.
    git(s.dir, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(s.dir, "side.txt"), "side\n");
    git(s.dir, "add", "-A");
    git(s.dir, "commit", "-qm", "side work");
    git(s.dir, "checkout", "-q", "main");
    git(s.dir, "merge", "-q", "--no-ff", "side", "-m", "Merge remote-tracking branch 'origin/side' into task/REC-011-auto-compact");

    const r = run(s, "--write");
    expect(r.code).toBe(0);
    const item = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8")).items[0];
    expect(item.merge.subject).toBe("merge: REC-011 auto-compact simulation (QC PASS)");
    expect(item.mergedSha).toBe(s.mergeSha);
    expect(item.mergeCandidates).toBeUndefined(); // candidates count is internal
  });

  it("FAILS on EVIDENCE_MISMATCH when a recorded mergedSha disagrees with the graph", () => {
    const s = sandbox({ recordedSha: "0123456789abcdef0123456789abcdef01234567" });
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("EVIDENCE_MISMATCH");
  });

  it("accepts a recorded mergedSha that agrees with the graph", () => {
    const s = sandbox();
    const r0 = run(s, "--write"); // backfill the true sha
    expect(r0.code).toBe(0);
    const r = run(s);
    expect(r.code).toBe(0);
  });

  it("--write backfills merge evidence and branchState, and is idempotent", () => {
    const s = sandbox({ recordedSha: null });
    expect(run(s, "--write").code).toBe(0);
    const after = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8"));
    const item = after.items[0];
    expect(item.merge.subject).toContain("REC-011");
    expect(item.mergedSha).toBe(s.mergeSha);
    expect(item.mergedAt).toBeTruthy();
    expect(item.branchState).toBe("absent"); // sandbox branch is task/REC-011-auto-compact

    const first = fs.readFileSync(s.ledgerPath, "utf8");
    run(s, "--write");
    expect(fs.readFileSync(s.ledgerPath, "utf8")).toBe(first);
  });

  it("records a live branch as present", () => {
    const s = sandbox();
    git(s.dir, "branch", "task/REC-011-auto-compact");
    run(s, "--write");
    const item = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8")).items[0];
    expect(item.branchState).toBe("present");
  });

  it("--write never overwrites a present-but-wrong mergedSha", () => {
    const s = sandbox({ recordedSha: "0123456789abcdef0123456789abcdef01234567" });
    run(s, "--write");
    const item = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8")).items[0];
    expect(item.mergedSha).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("preserves indentation and unrelated human-authored fields", () => {
    const s = sandbox();
    const before = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8"));
    before.items[0].note = "human history that must survive";
    fs.writeFileSync(s.ledgerPath, JSON.stringify(before, null, 1) + "\n");
    run(s, "--write");
    const raw = fs.readFileSync(s.ledgerPath, "utf8");
    expect(raw).toMatch(/\n "schema_version"/); // 1-space indent preserved
    expect(JSON.parse(raw).items[0].note).toBe("human history that must survive");
  });

  it("exits 1 with a clear message when the ledger is missing or malformed", () => {
    const s = sandbox();
    fs.rmSync(s.ledgerPath);
    const missing = run(s);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not found");

    fs.writeFileSync(s.ledgerPath, "{ not json");
    const bad = run(s);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("not valid JSON");
  });

  it("exits 1 with a clear message (not a stack trace) when the ledger is unreadable", () => {
    // An EACCES/EISDIR read used to escape the try/catch and surface as an uncaught
    // stack. Still fail-closed either way, but the operator should get the one-liner.
    const s = sandbox();
    fs.chmodSync(s.ledgerPath, 0o000);
    try {
      const r = run(s);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("unreadable");
      expect(r.stderr).not.toContain("at Object.readFileSync");
    } finally {
      fs.chmodSync(s.ledgerPath, 0o644); // let the sandbox cleanup succeed
    }
  });

  it("derives mergedAt from the merge commit, never from a stamped wall clock", () => {
    const s = sandbox();
    const original = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8"));
    // A wrong wall-clock stamp that disagrees with the commit it sits beside.
    original.items[0].mergedAt = "2001-01-01T00:00:00Z";
    original.items[0].mergedSha = s.mergeSha;
    fs.writeFileSync(s.ledgerPath, JSON.stringify(original, null, 1) + "\n");

    run(s, "--write");
    const item = JSON.parse(fs.readFileSync(s.ledgerPath, "utf8")).items[0];
    expect(item.mergedAt).not.toBe("2001-01-01T00:00:00Z");
    expect(item.mergedAt).toBe(item.merge.date);
  });

  it("--json emits a machine-readable report and no human noise on stdout", () => {
    const s = sandbox();
    const r = run(s, "--json");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.total).toBe(1);
    expect(report.substantiated).toBe(1);
    expect(report.failing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// QC evidence store
// ---------------------------------------------------------------------------
//
// A QC record cites the commit its verdict was rendered against. Task branches were
// rebased before promotion, so those citations can name commits that no longer exist in
// main — evidence that cannot be checked against the tree it certifies.

describe("task-ledger-verify — QC evidence citations", () => {
  const writeQc = (s: { dir: string }, id: string, commit: string, extra: Record<string, unknown> = {}) => {
    const dir = path.join(s.dir, "state", "task-updates");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.qc.json`),
      JSON.stringify({ taskId: id, phase: "PASS", commit, ...extra }, null, 2) + "\n",
    );
  };

  it("accepts a citation that is in main", () => {
    const s = sandbox();
    writeQc(s, "REC-011", s.mergeSha);
    const r = run(s, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).qc).toMatchObject({ total: 1, inMain: 1, repointable: 0 });
  });

  it("FAILS on a citation that is not in main's history", () => {
    const s = sandbox();
    writeQc(s, "REC-011", "0123456789abcdef0123456789abcdef01234567");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("QC record(s) UNSUBSTANTIATED");
  });

  it("--write repoints a dangling citation at the merge commit and keeps the original", () => {
    const s = sandbox();
    writeQc(s, "REC-011", "0123456789abcdef0123456789abcdef01234567");
    expect(run(s, "--write").code).toBe(0);
    const rec = JSON.parse(
      fs.readFileSync(path.join(s.dir, "state", "task-updates", "REC-011.qc.json"), "utf8"),
    );
    expect(rec.commit).toBe(s.mergeSha);
    expect(rec.preRebaseCommit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(rec.commitNote).toMatch(/rebased/);
  });

  it("prefers the MERGE commit over a later commit that merely mentions the id", () => {
    const s = sandbox();
    // A batch-control commit that lists the id in passing, after the merge.
    fs.writeFileSync(path.join(s.dir, "control.txt"), "batch-2 records: REC-011 merged\n");
    git(s.dir, "add", "-A");
    git(s.dir, "commit", "-qm", "control: batch-2 records (REC-011)");
    writeQc(s, "REC-011", "0123456789abcdef0123456789abcdef01234567");
    run(s, "--write");
    const rec = JSON.parse(
      fs.readFileSync(path.join(s.dir, "state", "task-updates", "REC-011.qc.json"), "utf8"),
    );
    // Must be the merge, not the newer control commit that only talks about it.
    expect(rec.commit).toBe(s.mergeSha);
    expect(rec.commit).not.toBe(git(s.dir, "rev-parse", "HEAD"));
  });

  it("is idempotent and preserves unrelated fields", () => {
    const s = sandbox();
    writeQc(s, "REC-011", "0123456789abcdef0123456789abcdef01234567", { notes: "keep me" });
    run(s, "--write");
    const p = path.join(s.dir, "state", "task-updates", "REC-011.qc.json");
    const first = fs.readFileSync(p, "utf8");
    run(s, "--write");
    expect(fs.readFileSync(p, "utf8")).toBe(first);
    expect(JSON.parse(first).notes).toBe("keep me");
  });

  it("does not fail when there is no QC store at all", () => {
    const s = sandbox();
    expect(run(s).code).toBe(0);
  });
});
