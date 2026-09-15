// SKR-042 tests — scripts/release/repo-residue.mjs
//
// Defect under test: 189 unreachable commits, a populated `.git/lost-found/` (370
// entries, 1.5 MB) and 29 committed `state/backup-*` snapshots had accumulated with
// nothing surfacing them.
//
// The guard is deliberately a THRESHOLD check on unreachable commits, not a zero check:
// ordinary work legitimately leaves a few unreachable objects, and a guard that fails on
// a healthy repo gets muted — which is worse than no guard. The tests below pin that
// budget behaviour explicitly, in both directions.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lostFoundEntries, scanResidue, trackedBackupSnapshots } from "./repo-residue.mjs";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** A small real repo — the guard shells out to git, so a fake fixture would not exercise it. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-residue-"));
  tmpRoots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

describe("repo-residue — lost-found", () => {
  it("counts nothing when .git/lost-found is absent", () => {
    expect(lostFoundEntries(repo())).toBe(0);
  });

  it("counts entries across subdirectories", () => {
    const root = repo();
    for (const sub of ["commit", "other"]) {
      fs.mkdirSync(path.join(root, ".git", "lost-found", sub), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "lost-found", sub, "a"), "x");
    }
    expect(lostFoundEntries(root)).toBe(2);
  });

  it("FAILS when .git/lost-found is populated", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, ".git", "lost-found", "commit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "lost-found", "commit", "deadbeef"), "x");
    const { findings } = scanResidue(root);
    expect(findings.map((f) => f.check)).toContain("lost-found");
  });
});

describe("repo-residue — tracked backup snapshots", () => {
  it("reports no snapshots on a clean repo", () => {
    expect(trackedBackupSnapshots(repo())).toEqual([]);
  });

  it("FAILS when a state/backup-* file is tracked", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "backup-pre-batch9-todo.md"), "old todo\n");
    git(root, "add", "-f", "state/backup-pre-batch9-todo.md");
    const { findings } = scanResidue(root);
    const hit = findings.find((f) => f.check === "tracked-backup-snapshots");
    expect(hit).toBeDefined();
    expect(hit!.detail).toMatch(/1 tracked state\/backup-\* snapshot/);
    expect(hit!.hint).toMatch(/git rm --cached/);
  });

  it("passes once the snapshot is untracked", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "backup-pre-batch9-todo.md"), "old todo\n");
    git(root, "add", "-f", "state/backup-pre-batch9-todo.md");
    git(root, "commit", "-qm", "add backup");
    git(root, "rm", "--cached", "-q", "state/backup-pre-batch9-todo.md");
    expect(scanResidue(root).findings.map((f) => f.check)).not.toContain("tracked-backup-snapshots");
  });
});

describe("repo-residue — unreachable commit budget", () => {
  /** Create a genuinely unreachable commit via `git stash create` (no ref is written). */
  function makeUnreachable(root: string) {
    fs.writeFileSync(path.join(root, "wip.txt"), "wip\n");
    git(root, "add", "-A");
    const sha = git(root, "stash", "create");
    git(root, "reset", "-q", "--hard", "HEAD");
    return sha;
  }

  it("counts unreachable commits", () => {
    const root = repo();
    const sha = makeUnreachable(root);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const { counts } = scanResidue(root, 25);
    expect(counts.unreachable).toBeGreaterThan(0);
  });

  it("PASSES a healthy repo that is merely under budget", () => {
    const root = repo();
    makeUnreachable(root);
    const { findings } = scanResidue(root, 25);
    expect(findings.map((f) => f.check)).not.toContain("unreachable-commits");
  });

  it("FAILS the same repo when the budget is exceeded", () => {
    const root = repo();
    makeUnreachable(root);
    const { findings } = scanResidue(root, 0);
    const hit = findings.find((f) => f.check === "unreachable-commits");
    expect(hit).toBeDefined();
    expect(hit!.hint).toMatch(/git gc --prune=now/);
  });

  it("names the budget in the failure detail so the fix is unambiguous", () => {
    const root = repo();
    makeUnreachable(root);
    const { findings } = scanResidue(root, 0);
    expect(findings[0].detail).toMatch(/budget 0/);
  });

  it("passes everything on a fresh repo", () => {
    expect(scanResidue(repo()).findings).toEqual([]);
  });
});
