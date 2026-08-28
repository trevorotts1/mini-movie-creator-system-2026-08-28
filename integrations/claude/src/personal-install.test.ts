import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SKL-003 integration tests: exercise the REAL personal-install.sh end to end
 * inside temporary fixture islands (canonical skill source + a fake $HOME), so
 * the operator's real ~/.claude/skills is never touched by the tests.
 * The script is the unit under test; fixtures prove its contract:
 *   - install creates $HOME/.claude/skills/mini-movie-creator -> <canonical> (absolute symlink)
 *   - second run is a no-op (idempotent)
 *   - a wrong symlink is repointed (no backup needed — a link holds no content)
 *   - a real file/dir is NEVER replaced without --force AND --confirm
 *   - --force --confirm backs the target up first (backup-<timestamp> dir)
 *   - --check exits 0 when installed (incl. canonical tree pending on SKL-001)
 *   - --check exits 1 when missing / wrong / dangling
 *   - --dry-run mutates nothing
 *   - --source installs from another checkout
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "personal-install.sh");

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixture(opts: { withCanonical?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skl003-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "integrations", "claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "integrations", "claude", "personal-install.sh"));
  fs.chmodSync(path.join(root, "integrations", "claude", "personal-install.sh"), 0o755);
  if (opts.withCanonical !== false) {
    writeCanonicalSkill(root, "fixture");
  }
  return { root, home };
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

function run(root: string, home: string, args: string[] = []) {
  return spawnSync("bash", [path.join(root, "integrations", "claude", "personal-install.sh"), ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

const TARGET = (home: string) => path.join(home, ".claude", "skills", "mini-movie-creator");
const CANON = (root: string) => path.join(root, "skills", "mini-movie-creator");

describe("SKL-003 personal-install.sh", () => {
  describe("install (symlink mode)", () => {
    it("creates $HOME/.claude/skills/mini-movie-creator -> canonical (absolute symlink)", () => {
      const { root, home } = makeFixture();
      const r = run(root, home);
      expect(r.status).toBe(0);
      const link = fs.lstatSync(TARGET(home));
      expect(link.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(TARGET(home))).toBe(CANON(root));
      // resolves to the canonical tree
      expect(fs.existsSync(path.join(TARGET(home), "SKILL.md"))).toBe(true);
    });

    it("is idempotent: second run is a no-op with exit 0", () => {
      const { root, home } = makeFixture();
      expect(run(root, home).status).toBe(0);
      const first = fs.lstatSync(TARGET(home)).mtimeMs;
      const r2 = run(root, home);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toMatch(/already installed|Nothing to do/);
      expect(fs.readlinkSync(TARGET(home))).toBe(CANON(root));
      expect(fs.lstatSync(TARGET(home)).mtimeMs).toBe(first);
    });

    it("repoints a wrong symlink (no backup needed — a link holds no content)", () => {
      const { root, home } = makeFixture();
      fs.symlinkSync("/nonexistent-then-wrong", TARGET(home));
      const r = run(root, home);
      expect(r.status).toBe(0);
      expect(fs.readlinkSync(TARGET(home))).toBe(CANON(root));
      // no backup dir created for a symlink repoint
      const backups = fs
        .readdirSync(path.join(home, ".claude", "skills"))
        .filter((n) => n.startsWith("mini-movie-creator.backup-"));
      expect(backups.length).toBe(0);
    });

    it("refuses to overwrite a real file/dir without --force", () => {
      const { root, home } = makeFixture();
      fs.writeFileSync(TARGET(home), "hand-made personal skill\n");
      const r = run(root, home);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Refusing to touch it/);
      expect(fs.readFileSync(TARGET(home), "utf8")).toBe("hand-made personal skill\n");
    });

    it("refuses `--force` WITHOUT typed `--confirm`", () => {
      const { root, home } = makeFixture();
      fs.mkdirSync(TARGET(home));
      fs.writeFileSync(path.join(TARGET(home), "SKILL.md"), "previous skill\n");
      const r = run(root, home, ["--force"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/WITHOUT typed confirmation/);
      // target intact
      expect(
        fs.readFileSync(path.join(TARGET(home), "SKILL.md"), "utf8"),
      ).toBe("previous skill\n");
      // nothing backed up (nothing was destroyed)
      const backups = fs
        .readdirSync(path.join(home, ".claude", "skills"))
        .filter((n) => n.startsWith("mini-movie-creator.backup-"));
      expect(backups.length).toBe(0);
    });

    it("--force --confirm backs up the replaced target before installing", () => {
      const { root, home } = makeFixture();
      fs.mkdirSync(TARGET(home));
      fs.writeFileSync(path.join(TARGET(home), "SKILL.md"), "previous skill\n");
      fs.mkdirSync(path.join(TARGET(home), "references"), { recursive: true });
      fs.writeFileSync(path.join(TARGET(home), "references", "extra.md"), "mine\n");
      const r = run(root, home, ["--force", "--confirm"]);
      expect(r.status).toBe(0);
      const backups = fs
        .readdirSync(path.join(home, ".claude", "skills"))
        .filter((n) => n.startsWith("mini-movie-creator.backup-"));
      expect(backups.length).toBe(1);
      // full backup, dereferenced copy of everything that was there
      expect(
        fs.readFileSync(path.join(home, ".claude", "skills", backups[0]!, "SKILL.md"), "utf8"),
      ).toBe("previous skill\n");
      expect(
        fs.readFileSync(path.join(home, ".claude", "skills", backups[0]!, "references", "extra.md"), "utf8"),
      ).toBe("mine\n");
      // replaced by the symlink
      expect(fs.lstatSync(TARGET(home)).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(TARGET(home))).toBe(CANON(root));
    });

    it("writes $HOME/.mmcs/mmcs.env with MMCS_REPO_ROOT so an out-of-repo session can locate the engine", () => {
      const { root, home } = makeFixture();
      const r = run(root, home);
      expect(r.status).toBe(0);
      const env = fs.readFileSync(path.join(home, ".mmcs", "mmcs.env"), "utf8");
      // the repo root this wrapper was invoked from (engine location), not the skill dir
      expect(env).toMatch(`export MMCS_REPO_ROOT="${root}"`);
      expect(env).toMatch(/export MMCS_CLI=.*apps\/cli\/dist\/index\.js/);
      // no secret-looking values: the file is paths + env names only
      expect(env).not.toMatch(/=sk-[A-Za-z0-9]{10,}|ghp_|AKIA|bearer/i);
    });

    it("fails with a clear error when the canonical source is absent", () => {
      const { root, home } = makeFixture({ withCanonical: false });
      const r = run(root, home);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/canonical skill source not found/);
      expect(fs.existsSync(TARGET(home))).toBe(false);
    });

    it("installs from an alternate checkout via --source", () => {
      const { root, home } = makeFixture({ withCanonical: false });
      const alt = path.join(root, "elsewhere", "mmcs");
      fs.mkdirSync(path.join(alt, "skills", "mini-movie-creator"), { recursive: true });
      fs.writeFileSync(
        path.join(alt, "skills", "mini-movie-creator", "SKILL.md"),
        "---\nname: mini-movie-creator\ndescription: alternate\n---\n# alt\n",
      );
      const r = run(root, home, ["--source", path.join(alt, "skills", "mini-movie-creator")]);
      expect(r.status).toBe(0);
      expect(fs.readlinkSync(TARGET(home))).toBe(
        path.join(alt, "skills", "mini-movie-creator"),
      );
    });

    it("--dry-run prints actions and mutates nothing (incl. $HOME)", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/DRY-RUN: would create|DRY-RUN: would install/);
      expect(fs.existsSync(TARGET(home))).toBe(false);
      expect(fs.existsSync(path.join(home, ".mmcs", "mmcs.env"))).toBe(false);
    });
  });

  describe("--check", () => {
    it("exits 0 on a correct symlink install with canonical present", () => {
      const { root, home } = makeFixture();
      run(root, home);
      const r = run(root, home, ["--check"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK:/);
      expect(r.stdout).toMatch(/SKILL.md found/);
    });

    it("exits 0 with a warning when canonical tree is still pending (SKL-001 not merged)", () => {
      const { root, home } = makeFixture({ withCanonical: false });
      // simulate the acceptance state on this branch: symlink points at the
      // canonical path (created while a skill stub was briefly present), tree
      // content arrives later (exactly like SKL-002's check).
      fs.mkdirSync(path.join(root, "skills", "mini-movie-creator"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "skills", "mini-movie-creator", "SKILL.md"),
        "stub\n",
      );
      run(root, home);
      fs.rmSync(path.join(root, "skills", "mini-movie-creator", "SKILL.md"));
      const r = run(root, home, ["--check"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/SKL-001 not merged|symlink resolves as soon as it lands/);
    });

    it("exits 1 when nothing is installed", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--check"]);
      expect(r.status).toBe(1);
    });

    it("exits 1 for a broken (dangling) symlink", () => {
      const { root, home } = makeFixture();
      fs.symlinkSync("/nowhere/mini-movie-creator", TARGET(home));
      const r = run(root, home, ["--check"]);
      expect(r.status).toBe(1);
    });

    it("exits 1 for a real directory at the target", () => {
      const { root, home } = makeFixture();
      fs.mkdirSync(TARGET(home));
      fs.writeFileSync(path.join(TARGET(home), "SKILL.md"), "tuned personal copy\n");
      const r = run(root, home, ["--check"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/does not point at/);
    });
  });

  describe("usage / safety gates", () => {
    it("rejects unknown options with exit 2", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--nonsense"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown option/);
    });

    it("rejects --force together with --check", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--check", "--force"]);
      expect(r.status).toBe(2);
    });

    it("rejects --confirm together with --check", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--check", "--confirm"]);
      expect(r.status).toBe(2);
    });

    it("rejects --confirm without --force", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--confirm"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--confirm only makes sense together with --force/);
    });

    it("rejects a missing --source argument with exit 2", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--source"]);
      expect(r.status).toBe(2);
    });

    it("rejects --source together with --check", () => {
      const { root, home } = makeFixture();
      const r = run(root, home, ["--check", "--source", CANON(root)]);
      expect(r.status).toBe(2);
    });

    it("records --repo-root in mmcs.env when the wrapper runs from a different checkout", () => {
      const { root, home } = makeFixture();
      // engine root = a clone of the repo that ALSO has the canonical skill
      // tree at <engineRoot>/skills/mini-movie-creator (the wrapper installs
      // FROM there too), so install succeeds while env records the engine root.
      const engineRoot = path.join(root, "engine");
      writeCanonicalSkill(engineRoot, "engine fixture");
      const r = run(root, home, ["--repo-root", engineRoot]);
      expect(r.status).toBe(0);
      expect(fs.readlinkSync(TARGET(home))).toBe(path.join(engineRoot, "skills", "mini-movie-creator"));
      const env = fs.readFileSync(path.join(home, ".mmcs", "mmcs.env"), "utf8");
      expect(env).toMatch(`export MMCS_REPO_ROOT="${engineRoot}"`);
    });
  });
});
