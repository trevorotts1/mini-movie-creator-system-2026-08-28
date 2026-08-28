import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SKL-002 integration tests: exercise the REAL project-install.sh end to end
 * inside a temporary fixture repo (canonical skill source + .claude/skills).
 * The script is the unit under test; fixtures prove its contract:
 *   - install creates .claude/skills/mini-movie-creator -> ../../skills/mini-movie-creator
 *   - second run is a no-op (idempotent)
 *   - --check exits 0 when installed, non-zero when missing/broken
 *   - refuses to clobber a real file/dir without --force; --force backs up first
 *   - copy mode (--copy) mirrors the canonical tree and resyncs on change
 *   - --dry-run mutates nothing
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "project-install.sh");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixture(opts: { withCanonical?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skl002-"));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, "integrations", "claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "integrations", "claude", "project-install.sh"));
  fs.chmodSync(path.join(root, "integrations", "claude", "project-install.sh"), 0o755);
  if (opts.withCanonical !== false) {
    writeCanonicalSkill(root, "fixture");
  }
  return root;
}

function writeCanonicalSkill(root: string, body: string) {
  const canon = path.join(root, "skills", "mini-movie-creator");
  fs.mkdirSync(path.join(canon, "references"), { recursive: true });
  fs.mkdirSync(path.join(canon, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(canon, "SKILL.md"),
    `---\nname: mini-movie-creator\ndescription: ${body}\n---\n\n# fixture skill\n`,
  );
  fs.writeFileSync(path.join(canon, "references", "workflow.md"), "workflow details\n");
  fs.writeFileSync(
    path.join(canon, "scripts", "mmcs-status.sh"),
    "#!/usr/bin/env bash\necho status\n",
  );
}

function run(root: string, args: string[] = []) {
  return spawnSync("bash", [path.join(root, "integrations", "claude", "project-install.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

const TARGET = (root: string) => path.join(root, ".claude", "skills", "mini-movie-creator");
const REL = "../../skills/mini-movie-creator";

describe("SKL-002 project-install.sh", () => {
  describe("install (symlink mode)", () => {
    it("creates .claude/skills/mini-movie-creator -> ../../skills/mini-movie-creator", () => {
      const root = makeFixture();
      const r = run(root);
      expect(r.status).toBe(0);
      const link = fs.lstatSync(TARGET(root));
      expect(link.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(TARGET(root))).toBe(REL);
      // resolves to the canonical tree
      expect(fs.existsSync(path.join(TARGET(root), "SKILL.md"))).toBe(true);
    });

    it("is idempotent: second run is a no-op with exit 0", () => {
      const root = makeFixture();
      expect(run(root).status).toBe(0);
      const first = fs.lstatSync(TARGET(root)).mtimeMs;
      const r2 = run(root);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toMatch(/already installed|Nothing to do/);
      // still the same symlink (not replaced)
      expect(fs.readlinkSync(TARGET(root))).toBe(REL);
      expect(fs.lstatSync(TARGET(root)).mtimeMs).toBe(first);
    });

    it("repoints a wrong symlink to the canonical source", () => {
      const root = makeFixture();
      fs.symlinkSync("../wrong", TARGET(root));
      const r = run(root);
      expect(r.status).toBe(0);
      expect(fs.readlinkSync(TARGET(root))).toBe(REL);
    });

    it("refuses to overwrite a real file/dir without --force", () => {
      const root = makeFixture();
      fs.writeFileSync(TARGET(root), "hand-made skill\n");
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Refusing to overwrite/);
      expect(fs.readFileSync(TARGET(root), "utf8")).toBe("hand-made skill\n");
    });

    it("--force backs up the replaced target before installing", () => {
      const root = makeFixture();
      fs.mkdirSync(TARGET(root));
      fs.writeFileSync(path.join(TARGET(root), "SKILL.md"), "previous skill\n");
      const r = run(root, ["--force"]);
      expect(r.status).toBe(0);
      const backups = fs
        .readdirSync(path.join(root, ".claude", "skills"))
        .filter((n) => n.startsWith("mini-movie-creator.backup-"));
      expect(backups.length).toBe(1);
      expect(
        fs.readFileSync(
          path.join(root, ".claude", "skills", backups[0], "SKILL.md"),
          "utf8",
        ),
      ).toBe("previous skill\n");
      expect(fs.readlinkSync(TARGET(root))).toBe(REL);
    });

    it("fails with a clear error when the canonical source is absent", () => {
      const root = makeFixture({ withCanonical: false });
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/canonical skill source not found/);
      expect(fs.existsSync(TARGET(root))).toBe(false);
    });

    it("--dry-run prints actions and mutates nothing", () => {
      const root = makeFixture();
      const r = run(root, ["--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/DRY-RUN: would create/);
      expect(fs.existsSync(TARGET(root))).toBe(false);
    });
  });

  describe("--check", () => {
    it("exits 0 on a correct symlink install", () => {
      const root = makeFixture();
      run(root);
      const r = run(root, ["--check"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK: .*mini-movie-creator/);
    });

    it("exits 0 for the committed symlink in the real repo checkout", () => {
      // The worktree ships .claude/skills/mini-movie-creator committed as a
      // relative symlink; --check must pass against the real repo root even
      // before SKL-001's canonical tree lands (skl004+ verify load behavior).
      const r = spawnSync("bash", [SCRIPT, "--check"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK:/);
    });

    it("exits 1 when nothing is installed", () => {
      const root = makeFixture();
      const r = run(root, ["--check"]);
      expect(r.status).toBe(1);
    });
    it("exits 1 for a broken (dangling) symlink", () => {
      const root = makeFixture();
      fs.symlinkSync("../../nowhere", TARGET(root));
      const r = run(root, ["--check"]);
      expect(r.status).toBe(1);
    });
  });

  describe("copy mode (--copy)", () => {
    it("mirrors the canonical tree and records a marker", () => {
      const root = makeFixture();
      const r = run(root, ["--copy"]);
      expect(r.status).toBe(0);
      expect(fs.statSync(TARGET(root)).isDirectory()).toBe(true);
      expect(
        fs.readFileSync(path.join(TARGET(root), "SKILL.md"), "utf8"),
      ).toMatch(/name: mini-movie-creator/);
      expect(
        fs.existsSync(path.join(root, ".claude", "skills", ".mini-movie-creator.copy-install")),
      ).toBe(true);
      // marker is not a copied skill file
      expect(fs.readdirSync(TARGET(root)).sort()).toEqual([
        "SKILL.md",
        "references",
        "scripts",
      ]);
    });

    it("is idempotent in copy mode when already in sync", () => {
      const root = makeFixture();
      run(root, ["--copy"]);
      const before = fs.statSync(path.join(TARGET(root), "SKILL.md")).mtimeMs;
      const r = run(root, ["--copy"]);
      expect(r.status).toBe(0);
      expect(fs.statSync(path.join(TARGET(root), "SKILL.md")).mtimeMs).toBe(before);
    });

    it("--check passes when in sync and fails when canonical changed", () => {
      const root = makeFixture();
      run(root, ["--copy"]);
      expect(run(root, ["--check"]).status).toBe(0);
      fs.appendFileSync(path.join(root, "skills", "mini-movie-creator", "SKILL.md"), "\n# change\n");
      expect(run(root, ["--check"]).status).toBe(1);
      // rerunning --copy repairs the drift
      expect(run(root, ["--copy"]).status).toBe(0);
      expect(run(root, ["--check"]).status).toBe(0);
    });

    it("resync adds new canonical files and removes stale ones", () => {
      const root = makeFixture();
      run(root, ["--copy"]);
      // new canonical file
      fs.writeFileSync(
        path.join(root, "skills", "mini-movie-creator", "references", "approvals.md"),
        "approvals\n",
      );
      // stale file only in target
      fs.writeFileSync(path.join(TARGET(root), "STALE.md"), "stale\n");
      run(root, ["--copy"]);
      expect(
        fs.existsSync(path.join(TARGET(root), "references", "approvals.md")),
      ).toBe(true);
      expect(fs.existsSync(path.join(TARGET(root), "STALE.md"))).toBe(false);
    });

    it("refuses --copy over an unrelated real directory without --force", () => {
      const root = makeFixture();
      fs.mkdirSync(TARGET(root), { recursive: true });
      fs.writeFileSync(path.join(TARGET(root), "other.txt"), "keep me\n");
      const r = run(root, ["--copy"]);
      // directory target: copy-sync would merge, which would NOT clobber
      // other.txt but pollutes a foreign dir; script must refuse instead.
      expect(r.status).toBe(1);
      expect(fs.readFileSync(path.join(TARGET(root), "other.txt"), "utf8")).toBe("keep me\n");
    });
  });

  describe("usage", () => {
    it("rejects unknown options with exit 2", () => {
      const root = makeFixture();
      const r = run(root, ["--nonsense"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown option/);
    });

    it("rejects --force together with --check", () => {
      const root = makeFixture();
      const r = run(root, ["--check", "--force"]);
      expect(r.status).toBe(2);
    });
  });
});