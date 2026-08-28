// SKL-006 acceptance tests: OpenClaw OPTIONAL global install for the
// mini-movie-creator skill (spec §27 target 3, runbook §43).
//
// Scope, per state/tasks.json:
//  - optional global install form documented + tested
//  - workspace install (<workspace>/skills, SKL-005) remains the supported default
//  - uninstall/rollback path verified
//  - `bash integrations/openclaw/global-install.sh --check` exits 0
//
// The end-to-end cases run the REAL `openclaw` CLI against an ISOLATED temp
// state dir via OPENCLAW_STATE_DIR (honored by OpenClaw 2026.7.1-2, verified
// live 2026-08-28) — nothing outside the temp dir is ever touched. When the
// CLI is unavailable the suite marks those cases skipped rather than passing
// vacuously (negative-result contract: a skip is named, never a fake green).
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync as readDirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "global-install.sh");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILL_SLUG = "mini-movie-creator";

let openclawAvailable = false;
try {
  execFileSync("openclaw", ["--version"], { stdio: "pipe" });
  openclawAvailable = true;
} catch {
  openclawAvailable = false;
}

/**
 * Child env. VITEST (and friends) MUST be stripped: the OpenClaw CLI
 * detects a vitest parent (`VITEST=true`) and silently suppresses its
 * `skills list --json` stdout (verified live 2026-08-28), which would turn
 * every verification probe into a false negative.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { VITEST: _v, VITEST_POOL_ID: _p, ...rest } = process.env;
  return { ...rest, ...extra };
}

/** Run the install script with args; returns {status, stdout, stderr}. */
function runScript(args: string[], env: Record<string, string>) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      env: childEnv(env),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Write a minimal valid skill fixture (SKILL.md at source root). */
function makeFixture(dir: string, description = "MMCS test fixture skill"): string {
  const skillDir = path.join(dir, "fixture", SKILL_SLUG);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${SKILL_SLUG}\ndescription: ${description}\n---\n# Mini Movie Creator (test fixture)\n`,
  );
  return skillDir;
}

/** Parse `openclaw skills list --json` output for one skill entry. */
function listSkill(stateDir: string, agent?: string):
  | { name: string; source: string; eligible: boolean }
  | undefined {
  const args = ["skills", "list", "--json"];
  if (agent) args.push("--agent", agent);
  let out: string;
  try {
    out = execFileSync("openclaw", args, {
      env: childEnv({ OPENCLAW_STATE_DIR: stateDir }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  // The CLI may print ANSI status lines before the JSON payload.
  const start = out.indexOf("{");
  if (start < 0) return undefined;
  let data: { skills?: Array<{ name: string; source?: string; eligible?: boolean }> };
  try {
    data = JSON.parse(out.slice(start));
  } catch {
    return undefined;
  }
  const hit = (data.skills ?? []).find((s) => s.name === SKILL_SLUG);
  if (!hit) return undefined;
  return {
    name: hit.name,
    source: hit.source ?? "",
    eligible: hit.eligible === true,
  };
}

/** Isolated temp environment: fixture dir + OPENCLAW_STATE_DIR (never the real one). */
function makeEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "mmcs-skl006-vitest."));
  return {
    root,
    stateDir: path.join(root, "state"),
    env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("SKL-006 script properties", () => {
  it("exists, is executable, and is bash-syntax-clean", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const check = runScriptSyntax(SCRIPT);
    expect(check.status).toBe(0);
  });

  it("documents the optional global form and that workspace install is the supported default", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/--global/);
    expect(src).toMatch(/openclaw skills install/);
    expect(src).toContain("SUPPORTED DEFAULT");
    expect(src).toContain("OPTIONAL");
    // uninstall/rollback path documented, not improvised
    expect(src).toContain("--uninstall");
    expect(src).toMatch(/no uninstall/); // documents missing CLI uninstall
  });

  it("never reads or prints secret values (spec §26/§29)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/\.env/);
    // only OPENCLAW_STATE_DIR / MMCS_OPENCLAW_SKILL_SOURCE may be referenced
    const envRefs = [...src.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
    const forbidden = envRefs.filter((v) =>
      /(_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY)/.test(v),
    );
    expect(forbidden).toEqual([]);
  });

  it("--help exits 0 and mentions --check, --uninstall, --source", () => {
    const r = runScript(["--help"], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--check");
    expect(r.stdout).toContain("--uninstall");
    expect(r.stdout).toContain("--source");
  });

  it("rejects unknown arguments with exit 2 (no accidental install)", () => {
    const r = runScript(["--definitely-not-a-flag"], { OPENCLAW_STATE_DIR: "/tmp" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });
});

describe("SKL-006 --check (acceptance: exits 0)", () => {
  it("exits 0 and proves the full lifecycle in an isolated state dir", () => {
    const r = runScript(["--check"], {});
    expect(r.status).toBe(0);
    // check output must state the default-vs-optional relationship
    expect(r.stdout).toContain("supported default");
    expect(r.stdout).toContain("OPTIONAL");
    // self-test evidence, not just a bare exit code
    expect(r.stdout).toContain("self-test install");
    expect(r.stdout).toContain("self-test uninstall/rollback path OK");
    expect(r.stdout).toContain("ALL OK");
  });
});

describe("SKL-006 end-to-end against the real openclaw CLI (isolated state dir)", () => {
  it.skipIf(!openclawAvailable)("install --global makes the skill visible with source openclaw-managed", () => {
    const e = makeEnv();
    try {
      const fixture = makeFixture(e.root);
      const r = runScript(["--source", fixture], e.env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("shared managed skills dir");
      const listed = listSkill(e.stateDir);
      expect(listed).toBeDefined();
      expect(listed?.source).toBe("openclaw-managed");
      expect(listed?.eligible).toBe(true);
      // target layout: <state-dir>/skills/<slug>/SKILL.md
      expect(existsSync(path.join(e.stateDir, "skills", SKILL_SLUG, "SKILL.md"))).toBe(true);
    } finally {
      e.cleanup();
    }
  });

  it.skipIf(!openclawAvailable)("reinstall backs up the previous global copy (never destroys without backup)", () => {
    const e = makeEnv();
    try {
      const fixture = makeFixture(e.root);
      expect(runScript(["--source", fixture], e.env).status).toBe(0);
      const r2 = runScript(["--source", fixture], e.env);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toMatch(/backed up to: .+\.mmcs-global-install-backups\//);
      expect(existsSync(path.join(e.stateDir, "skills", ".mmcs-global-install-backups"))).toBe(true);
      // fresh copy still installed and visible
      expect(listSkill(e.stateDir)?.source).toBe("openclaw-managed");
    } finally {
      e.cleanup();
    }
  });

  it.skipIf(!openclawAvailable)("uninstall removes the global copy, backs it up, and prints the rollback command", () => {
    const e = makeEnv();
    try {
      const fixture = makeFixture(e.root);
      expect(runScript(["--source", fixture], e.env).status).toBe(0);
      expect(listSkill(e.stateDir)).toBeDefined();
      const r = runScript(["--uninstall"], e.env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("backup at:");
      expect(r.stdout).toMatch(/rollback: mv /);
      expect(existsSync(path.join(e.stateDir, "skills", SKILL_SLUG))).toBe(false);
      expect(listSkill(e.stateDir)).toBeUndefined();
      // the backup itself is restorable: <backups>/<slug>-<ts>/<slug>/SKILL.md
      const backups = path.join(e.stateDir, "skills", ".mmcs-global-install-backups");
      expect(existsSync(backups)).toBe(true);
      const stamp = readDirSync(backups)[0];
      expect(stamp).toMatch(new RegExp(`^${SKILL_SLUG}-\\d{8}T\\d{6}Z$`));
      expect(existsSync(path.join(backups, stamp, SKILL_SLUG, "SKILL.md"))).toBe(true);
    } finally {
      e.cleanup();
    }
  });

  it.skipIf(!openclawAvailable)("uninstall is a no-op when nothing is installed", () => {
    const e = makeEnv();
    try {
      const r = runScript(["--uninstall"], e.env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("nothing to uninstall");
      expect(r.stdout).toContain("workspace copy"); // points to SKL-005's default
    } finally {
      e.cleanup();
    }
  });

  it.skipIf(!openclawAvailable)("workspace copy wins by precedence; global uninstall never touches it", () => {
    const e = makeEnv();
    try {
      const fixture = makeFixture(e.root);
      expect(runScript(["--source", fixture], e.env).status).toBe(0);
      // place a workspace copy (the supported default, as SKL-005 does)
      const wsSkill = path.join(e.stateDir, "workspace-default", "skills", SKILL_SLUG);
      mkdirSync(wsSkill, { recursive: true });
      writeFileSync(
        path.join(wsSkill, "SKILL.md"),
        `---\nname: ${SKILL_SLUG}\ndescription: WORKSPACE copy (supported default)\n---\n`,
      );
      // agent default workspace resolves under <state-dir>/workspace-default
      expect(listSkill(e.stateDir, "default")?.source).toBe("openclaw-workspace");
      // uninstall the global copy — the workspace copy must survive
      const r = runScript(["--uninstall"], e.env);
      expect(r.status).toBe(0);
      expect(existsSync(wsSkill)).toBe(true);
      expect(listSkill(e.stateDir, "default")?.source).toBe("openclaw-workspace");
    } finally {
      e.cleanup();
    }
  });
});

/** bash -n syntax probe (separate helper so the describe above stays readable). */
function runScriptSyntax(script: string) {
  try {
    const stdout = execFileSync("bash", ["-n", script], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number };
    return { status: e.status ?? -1, stdout: "" };
  }
}