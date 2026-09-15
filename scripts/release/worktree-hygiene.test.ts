// SKR-041 tests — scripts/release/worktree-hygiene.mjs
//
// Defect under test: files sat untracked/modified inside task worktrees (four npm
// lockfiles in a pnpm repo, two stale one-line QC sha restamps, a superseded root vitest
// config). Nothing surfaced them, so `git worktree prune` would have destroyed them
// silently — and a stale QC restamp left in a worktree is worse than losing it, because
// unreviewed state that looks like evidence is actively misleading.
//
// Strategy: build a real outer git repo with real linked worktrees. The guard shells out
// to git, so a filesystem-only fixture would not exercise it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifyEntry, scanWorktreesIn } from "./worktree-hygiene.mjs";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** An outer repo plus one linked worktree under `<repo>/worktrees/REC-001`. */
function repoWithWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-wt-"));
  tmpRoots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  fs.mkdirSync(path.join(root, "state", "task-updates"), { recursive: true });
  fs.writeFileSync(path.join(root, "state", "task-updates", "AAA-001.qc.json"), '{"taskId":"AAA-001"}\n');
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  fs.mkdirSync(path.join(root, "worktrees"), { recursive: true });
  const wt = path.join(root, "worktrees", "REC-001");
  git(root, "worktree", "add", "-q", "-b", "task/REC-001", wt);
  return { root, wt };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("classifyEntry", () => {
  it("treats an npm lockfile as disposable with a stated reason", () => {
    const r = classifyEntry("?? package-lock.json");
    expect(r.verdict).toBe("DISPOSABLE");
    expect(r.reason).toMatch(/pnpm/);
  });

  it("treats an untracked file with no documented pattern as UNCLASSIFIED", () => {
    expect(classifyEntry("?? scratch.ts").verdict).toBe("UNCLASSIFIED");
  });

  it("treats any change to a tracked QC evidence record as EVIDENCE, not disposable", () => {
    const r = classifyEntry(" M state/task-updates/AAA-001.qc.json");
    expect(r.verdict).toBe("EVIDENCE");
    expect(r.reason).toMatch(/QC evidence/);
  });

  it("treats a modified tracked file as UNCLASSIFIED (never silently allowed)", () => {
    expect(classifyEntry(" M src/index.ts").verdict).toBe("UNCLASSIFIED");
    expect(classifyEntry("M  src/index.ts").verdict).toBe("UNCLASSIFIED");
  });

  it("handles quoted porcelain paths containing spaces", () => {
    expect(classifyEntry('?? "has space.txt"').file).toBe("has space.txt");
  });
});

// ---------------------------------------------------------------------------
// end to end against real worktrees
// ---------------------------------------------------------------------------

describe("worktree-hygiene — end to end", () => {
  it("passes when the linked worktree is clean", () => {
    const { root } = repoWithWorktree();
    const { actionable } = scanWorktreesIn(root);
    expect(actionable).toEqual([]);
  });

  it("FAILS on an undocumented untracked file", () => {
    const { root, wt } = repoWithWorktree();
    fs.writeFileSync(path.join(wt, "scratch.ts"), "export const x=1;\n");
    const { actionable } = scanWorktreesIn(root);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].verdict).toBe("UNCLASSIFIED");
    expect(actionable[0].file).toBe("scratch.ts");
  });

  it("FAILS on a modified tracked file", () => {
    const { root, wt } = repoWithWorktree();
    fs.appendFileSync(path.join(wt, "README.md"), "stray\n");
    const { actionable } = scanWorktreesIn(root);
    expect(actionable.map((a) => a.file)).toContain("README.md");
  });

  it("FAILS on an untracked file inside the evidence path", () => {
    const { root, wt } = repoWithWorktree();
    fs.writeFileSync(path.join(wt, "state/task-updates/ZZZ-999.qc.json"), "{}\n");
    const { actionable } = scanWorktreesIn(root);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].verdict).toBe("EVIDENCE");
  });

  it("allows a disposable npm lockfile but still reports it (not silent)", () => {
    const { root, wt } = repoWithWorktree();
    fs.writeFileSync(path.join(wt, "package-lock.json"), "{}\n");
    const { actionable, worktrees } = scanWorktreesIn(root);
    expect(actionable).toEqual([]);
    const found = worktrees.flatMap((w) => w.findings).filter((f) => f.verdict === "DISPOSABLE");
    expect(found).toHaveLength(1); // reported, not swallowed
  });

  it("does not fail on the primary checkout's own in-flight work", () => {
    const { root } = repoWithWorktree();
    fs.writeFileSync(path.join(root, "in-flight.ts"), "export const wip=1;\n");
    const { actionable } = scanWorktreesIn(root);
    expect(actionable).toEqual([]);
  });

  it("reports, but does not fail on, an external worktree outside worktrees/", () => {
    const { root } = repoWithWorktree();
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-ext-"));
    tmpRoots.push(ext);
    fs.rmSync(ext, { recursive: true, force: true });
    git(root, "worktree", "add", "-q", "--detach", ext, "HEAD");
    fs.writeFileSync(path.join(ext, "scratch.ts"), "export const x=1;\n");
    const { actionable, outOfScope } = scanWorktreesIn(root);
    expect(actionable).toEqual([]); // not this repo's task worktree
    // The guard reports real paths (git does), and os.tmpdir() is a symlink on macOS.
    expect(outOfScope.map((o) => fs.realpathSync(o.worktree))).toContain(fs.realpathSync(ext));
  });

  it("is NOT neutered when the repo path is spelled with different casing", () => {
    // Scoping used to compare the caller's repoRoot against git's worktree paths. On APFS
    // `fs.realpathSync` does NOT canonicalise character case, so `/…/Projects/x` and
    // `/…/projects/x` produced two different "real" roots: the primary checkout was read as
    // external, every project worktree fell out of scope, and the guard exited 0 on exactly
    // the state that fails when invoked directly. Both sides now come from git.
    const { root, wt } = repoWithWorktree();
    fs.writeFileSync(path.join(wt, "stray.ts"), "export const x=1;\n");

    expect(scanWorktreesIn(root).actionable).toHaveLength(1);

    // Flip the case of the sandbox directory's own name. APFS is case-insensitive, so this
    // spelling resolves to the same repo while differing from git's reported path.
    const dir = path.basename(root);
    const flipped = dir.replace(/[a-z]/, (c) => c.toUpperCase());
    const alt = path.join(path.dirname(root), flipped);
    // Only meaningful where the case-variant actually resolves (case-insensitive volume).
    if (flipped !== dir && fs.existsSync(alt)) {
      const viaAlt = scanWorktreesIn(alt);
      expect(viaAlt.actionable, "case-variant spelling must reach the same verdict").toHaveLength(1);
      expect(viaAlt.outOfScope, "project worktrees must not fall out of scope").toEqual([]);
    }
  });

  it("scans every linked worktree, not just the first", () => {
    const { root } = repoWithWorktree();
    const second = path.join(root, "worktrees", "REC-002");
    git(root, "worktree", "add", "-q", "-b", "task/REC-002", second);
    fs.writeFileSync(path.join(second, "stray.ts"), "export const x=1;\n");
    const { actionable } = scanWorktreesIn(root);
    expect(actionable).toHaveLength(1);
    expect(fs.realpathSync(actionable[0].worktree)).toBe(fs.realpathSync(second));
  });
});
