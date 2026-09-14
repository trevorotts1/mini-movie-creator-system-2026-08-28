import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SKR-030 regression tests: install-client.sh must fail fast rather than report
 * progress it did not make. Each fixture pre-seeds the skill directory (so the
 * copy step is a no-op) and drops a stub env-preflight.sh in it, leaving the
 * installer's own control flow as the unit under test:
 *   - the routing map's parent directory is created on a box that has none
 *   - a missing map file does not abort the registration (nothing to back up)
 *   - the map is backed up before an existing map is rewritten
 *   - a BLOCKED preflight is NOT reported as a successful install (exit status
 *     is the preflight's, because the script runs with `set -e`)
 *   - a failed skill copy aborts before the routing map / AGENTS.md are touched
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "mini-movie-creator", "install-client.sh");
const HAS_PYTHON3 = spawnSync("python3", ["--version"]).status === 0;

interface Fixture {
  root: string;
  skillsDir: string;
  dest: string;
  map: string;
  agents: string;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixture(opts: { preflightExit?: number } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-install-client-"));
  fixtures.push(root);
  const skillsDir = path.join(root, "skills");
  const dest = path.join(skillsDir, "75-mini-movie-creator");
  fs.mkdirSync(path.join(dest, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dest, "scripts", "env-preflight.sh"),
    `#!/usr/bin/env bash\necho "env-preflight: STUB"\nexit ${opts.preflightExit ?? 0}\n`,
  );
  // Parent intentionally missing: a fresh box has no skills tree yet.
  const map = path.join(root, "openclaw", "nested", "skill-department-map.json");
  const agents = path.join(root, "workspace", "AGENTS.md");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, "# client agents\n");
  return { root, skillsDir, dest, map, agents };
}

function run(fx: Fixture, args: string[] = []) {
  return spawnSync(
    "bash",
    [SCRIPT, "--skills-dir", fx.skillsDir, "--map", fx.map, "--agents", fx.agents, ...args],
    {
      encoding: "utf8",
      // MMCS_ROOT is this fixture (which has no skill tree) and the mount
      // fallback is forced to a nonexistent path, so the copy step can never
      // silently succeed against a real checkout on the host.
      env: {
        ...process.env,
        MMCS_ROOT: fx.root,
        MMCS_REPO_SRC: path.join(fx.root, "no-such-mount"),
      },
    },
  );
}

function readMap(mapPath: string): { skills: Array<{ slug: string }> } {
  return JSON.parse(fs.readFileSync(mapPath, "utf8")) as { skills: Array<{ slug: string }> };
}

describe("install-client.sh (SKR-030)", () => {
  it.skipIf(!HAS_PYTHON3)(
    "creates the routing-map parent directory and registers the slug when no map exists yet",
    () => {
      const fx = makeFixture();
      const r = run(fx);
      expect(r.status).toBe(0);
      // the parent dir was created instead of raising ENOENT out of python
      expect(fs.existsSync(fx.map)).toBe(true);
      expect(readMap(fx.map).skills.map((s) => s.slug)).toEqual(["mini-movie-creator"]);
      expect(r.stdout).toContain("map: registered mini-movie-creator");
      // nothing existed to back up — and nothing raised trying to copy it
      expect(fs.existsSync(`${fx.map}.bak-mmcs75`)).toBe(false);
    },
  );

  it.skipIf(!HAS_PYTHON3)("is idempotent on a second pass and backs up the existing map", () => {
    const fx = makeFixture();
    expect(run(fx).status).toBe(0);
    const second = run(fx);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("map: already registered");
    expect(readMap(fx.map).skills.length).toBe(1);
    // the second pass rewrites the JSON, so the pre-existing map is backed up
    expect(fs.existsSync(`${fx.map}.bak-mmcs75`)).toBe(true);
  });

  it.skipIf(!HAS_PYTHON3)("reports the preflight's BLOCKED exit instead of success", () => {
    const fx = makeFixture({ preflightExit: 2 });
    const r = run(fx);
    expect(r.stdout).toContain("env-preflight: STUB");
    expect(r.status).toBe(2);
  });

  it("aborts before mutating the routing map or AGENTS.md when the skill copy fails", () => {
    const fx = makeFixture();
    fs.rmSync(fx.dest, { recursive: true, force: true });
    const r = run(fx);
    expect(r.status).not.toBe(0);
    // no partial progress: the client's routing map and AGENTS.md stay untouched
    expect(fs.existsSync(fx.map)).toBe(false);
    expect(fs.readFileSync(fx.agents, "utf8")).toBe("# client agents\n");
  });
});
