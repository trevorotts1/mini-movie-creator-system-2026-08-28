// REL-002 tests — scripts/release/regression.sh (acceptance: full vitest suite
// + `npm run gen` + `npx tsc --noEmit` + lint + Remotion render smoke (16:9 +
// 9:16) + ffprobe availability check all pass in ONE scripted run; script
// exits 0 with a per-area summary).
//
// Strategy: each unit test builds a SANDBOX repo in a temp dir with the
// layout the script checks, plus a COPY of the real script at the same
// relative path (the script anchors REPO_ROOT to its own location, so sandbox
// runs must run the sandbox copy). The script's PATH is controlled per test —
// fake ffmpeg/ffprobe/pnpm/node — so every area can be forced green or red
// without the real toolchain. The pristine end-to-end case IS exercised for
// real in the final test: the real script runs against the real worktree with
// the real toolchain (excluding itself from its own vitest area to avoid
// recursion).
//
// NOTE: this file must never be picked up by the vitest area of a regression
// run launched from within it. The script excludes it via
// `vitest run --exclude scripts/release/regression.test.ts` AND exports
// MMCS_REGRESSION_CHILD=1 — this test asserts both guards exist in the script.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/release/regression.sh");
const SMOKE_HELPER = path.join(REPO_ROOT, "scripts/release/regression-render-smoke.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function spawnBash(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout?: number): RunResult {
  const res = spawnSync("bash", [script, ...args], { cwd, env, encoding: "utf8", timeout });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** PATH: system dirs + sandbox bin dir. Deliberately NO /opt/homebrew/bin —
 * the real toolchain must not leak into sandbox expectations (a test that
 * removes the fake ffprobe must see the area fail, not find the real one). */
function sandboxPath(binDir: string): string {
  return `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`;
}

interface Sandbox {
  root: string;
  binDir: string;
  run: (extraEnv?: NodeJS.ProcessEnv, args?: string[]) => RunResult;
}

/** Minimal repo skeleton the script accepts; areas are driven by fake tools. */
function withSandbox(
  fn: (s: Sandbox) => void,
  opts: { omitRemotionNodeModules?: boolean } = {},
): void {
  const root = mkdtempSync(path.join(tmpdir(), "mmcs-regression-sandbox-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(root, "remotion/src/episodic"), { recursive: true });
  mkdirSync(path.join(root, "packages/core/src"), { recursive: true });
  // media/ = Remotion public root the smoke helper requires.
  mkdirSync(path.join(root, "media"), { recursive: true });
  // Sandbox git repo — the gen idempotency gate reads `git status --porcelain`.
  const git = spawnSync("git", ["init", "-q"], { cwd: root });
  if (git.status !== 0) throw new Error("git init failed in sandbox");
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sandbox-mmcs", version: "0.0.0", private: true }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(
    path.join(root, "remotion/package.json"),
    JSON.stringify({ name: "sandbox-remotion", version: "0.0.0", scripts: { gen: "exit 0" } }),
  );
  writeFileSync(
    path.join(root, "remotion/src/shots.manifest.json"),
    JSON.stringify([{ id: "Short1Chess", durationInSeconds: 42, fps: 30, width: 1080, height: 1920 }]),
  );
  writeFileSync(
    path.join(root, "remotion/src/episodic/episode-registry.gen.ts"),
    `export const episodeCompositions = [{ "compositionId": "S01E01" }];\n`,
  );
  // One project tsconfig (include present) — the typecheck area's real target.
  writeFileSync(
    path.join(root, "packages/core/tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }),
  );
  writeFileSync(path.join(root, "packages/core/src/index.ts"), "export const ok = 1;\n");
  // Tracked generated files so the gen gate has a porcelain baseline.
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
  if (!opts.omitRemotionNodeModules) {
    mkdirSync(path.join(root, "remotion/node_modules/@remotion"), { recursive: true });
  }
  // Real script at its canonical relative path; a GREEN smoke-helper stub
  // (the real helper needs @remotion deps the sandbox does not have — it is
  // exercised for real in the end-to-end test below; failing-helper behavior
  // is tested by overwriting this stub).
  mkdirSync(path.join(root, "scripts/release"), { recursive: true });
  copyFileSync(SCRIPT, path.join(root, "scripts/release/regression.sh"));
  writeFileSync(
    path.join(root, "scripts/release/regression-render-smoke.mjs"),
    "console.log('  9:16 stub rendered'); console.log('  16:9 stub rendered'); console.log('SMOKE_OK'); process.exit(0);\n",
  );
  const run = (extraEnv: NodeJS.ProcessEnv = {}, args: string[] = []): RunResult =>
    spawnBash(path.join(root, "scripts/release/regression.sh"), args, root, {
      ...process.env,
      PATH: sandboxPath(binDir),
      ...extraEnv,
    });
  try {
    fn({ root, binDir, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Fake tool on the sandbox PATH: named executable printing a version line. */
function fakeTool(binDir: string, name: string, body: string): void {
  writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** Default fake toolchain: everything green, cheap, deterministic. */
function installGreenToolchain(binDir: string): void {
  fakeTool(binDir, "ffmpeg", 'if [ "$1" = "-version" ]; then echo "ffmpeg version 8.1.1"; exit 0; fi; exit 0');
  fakeTool(binDir, "ffprobe", 'if [ "$1" = "-version" ]; then echo "ffprobe version 8.1.1"; exit 0; fi; exit 0');
  fakeTool(
    binDir,
    "node",
    `#!/usr/bin/env bash
if [ "$1" = "-v" ]; then echo "v26.0.0"; exit 0; fi
# Real .mjs scripts (the smoke helper and its stubs) must actually run —
# forward to the real node binary this test process is itself running on.
case "$1" in
  *.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;
esac
exit 0
`,
  );
  fakeTool(
    binDir,
    "npm",
    `#!/usr/bin/env bash
# npm run gen: green.
exit 0
`,
  );
  fakeTool(
    binDir,
    "npx",
    `#!/usr/bin/env bash
# npx vitest run: green. npx tsc --noEmit: green. ($1 is the command name.)
exit 0
`,
  );
  fakeTool(
    binDir,
    "pnpm",
    `#!/usr/bin/env bash
# pnpm -r --if-present run lint: green — AND the runner must propagate a
# failing workspace script (the control depends on it). Simulate: when the
# cwd is a lint-control sandbox (its package.json lint script is exit 3),
# fail with the script's code.
if [ -f packages/lint-control/package.json ] && grep -q '"lint": "exit 3"' packages/lint-control/package.json 2>/dev/null; then
  exit 3
fi
exit 0
`,
  );
}

/** Make exactly one area fail by replacing its tool with a failing stub. */
function breakTool(binDir: string, name: string, body: string): void {
  fakeTool(binDir, name, body);
}

describe("regression.sh — unit (sandbox, fake toolchain)", () => {
  it("exits 0 with a per-area summary when every area passes", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      const r = run();
      if (r.status !== 0) console.error(r.stdout, r.stderr);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("== MMCS full regression ==");
      for (const area of ["tools", "vitest", "gen", "typecheck", "lint", "render-smoke"]) {
        expect(r.stdout).toContain(`PASS [${area}]`);
      }
      expect(r.stdout).not.toContain("FAIL [");
      expect(r.stdout).toContain("regression: PASS");
    });
  }, 60_000);

  it("exits 0 with valid JSON when --json is passed", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      const r = run({}, ["--json"]);
      expect(r.status).toBe(0);
      const line = r.stdout.split("\n").filter((l) => l.startsWith('{"step":"regression"'))[0];
      expect(line).toBeDefined();
      const parsed = JSON.parse(line) as { status: string; areas: Record<string, string> };
      expect(parsed.status).toBe("ok");
      expect(Object.values(parsed.areas)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    });
  }, 60_000);

  it("fails (exit 1) when ffprobe is missing from PATH, names the tools area", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      rmSync(path.join(binDir, "ffprobe"));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [tools]");
      expect(r.stdout).toContain("regression: FAILED");
    });
  }, 60_000);

  it("fails (exit 1) when ffprobe exists but is NOT executable (name-only resolution)", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      // Non-executable file: command -v finds the name, execution fails.
      writeFileSync(path.join(binDir, "ffprobe"), "not executable", { mode: 0o644 });
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [tools]");
    });
  }, 60_000);

  it("fails (exit 1) when the vitest suite fails, and reports failing files", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      breakTool(
        binDir,
        "npx",
        `#!/usr/bin/env bash
if [ "$1" = "vitest" ]; then
  echo " FAIL  packages/core/src/broken.test.ts" >&2
  echo "Tests  3 failed | 100 passed (103)" >&2
  exit 1
fi
exit 0
`,
      );
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [vitest]");
      expect(r.stdout).toContain("packages/core/src/broken.test.ts");
    });
  }, 60_000);

  it("vitest flake retry: rescues a once-only failure and DISCLOSES the retry in the note", () => {
    withSandbox(({ binDir, root, run }) => {
      installGreenToolchain(binDir);
      // First `npx vitest` pass fails one timing-sensitive file; the retry
      // (same file as positional arg) is green. A count file tracks passes.
      const countFile = path.join(root, "npx-vitest-count");
      writeFileSync(countFile, "0");
      breakTool(
        binDir,
        "npx",
        `#!/usr/bin/env bash
COUNT_FILE="${countFile}"
if [ "$1" = "vitest" ]; then
  N=$(cat "$COUNT_FILE")
  N=$((N + 1))
  echo "$N" > "$COUNT_FILE"
  if [ "$N" -eq 1 ]; then
    echo " FAIL  packages/core/src/timing.test.ts > cross-process lock" >&2
    echo "Tests  1 failed | 100 passed (101)" >&2
    exit 1
  fi
  echo "Tests  1 passed (1)" >&2
  exit 0
fi
exit 0
`,
      );
      const r = run();
      if (r.status !== 0) console.error(r.stdout, r.stderr);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("PASS [vitest]");
      expect(r.stdout).toContain("flake retry");
      // The retry targeted ONLY the failing file (not the whole suite).
      expect(r.stdout).toContain("1 file(s) green on rerun");
    });
  }, 60_000);

  it("vitest flake retry does NOT rescue a persistent failure (real regression fails twice)", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      breakTool(
        binDir,
        "npx",
        `#!/usr/bin/env bash
if [ "$1" = "vitest" ]; then
  echo " FAIL  packages/core/src/broken.test.ts" >&2
  echo "Tests  3 failed | 100 passed (103)" >&2
  exit 1
fi
exit 0
`,
      );
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [vitest]");
      expect(r.stdout).not.toContain("flake retry");
    });
  }, 60_000);

  it("fails (exit 1) when gen drifts the committed generated files", () => {
    withSandbox(({ binDir, root, run }) => {
      installGreenToolchain(binDir);
      breakTool(
        binDir,
        "npx",
        `#!/usr/bin/env bash
exit 0
`,
      );
      // The gen script succeeds but rewrites a committed generated file.
      writeFileSync(path.join(root, "remotion/src/shots.manifest.json"), "[]");
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [gen]");
      expect(r.stdout).toContain("drifted");
    });
  }, 60_000);

  it("fails (exit 1) when a project tsconfig fails tsc --noEmit", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      // npx tsc fails only when the first arg is tsc.
      breakTool(
        binDir,
        "npx",
        `#!/usr/bin/env bash
if [ "$1" = "tsc" ]; then echo "error TS2304: Cannot find name 'x'" >&2; exit 1; fi
exit 0
`,
      );
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [typecheck]");
    });
  }, 60_000);

  it("skips base-only tsconfigs (no include/files) and counts only project configs", () => {
    withSandbox(({ binDir, root, run }) => {
      installGreenToolchain(binDir);
      // A base-only config must NOT be passed to tsc (its sweep would include
      // test files project configs exclude).
      writeFileSync(
        path.join(root, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const r = run();
      if (r.status !== 0) console.error(r.stdout, r.stderr);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/1 project tsconfig\(s\) clean \(1 base config\(s\) skipped/);
    });
  }, 60_000);

  it("fails (exit 1) when lint fails", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      breakTool(
        binDir,
        "pnpm",
        `#!/usr/bin/env bash
exit 1
`,
      );
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [lint]");
    });
  }, 60_000);

  it("fails the lint area when the runner cannot fail (control catches silent-green)", () => {
    withSandbox(({ binDir, run }) => {
      installGreenToolchain(binDir);
      // pnpm always exits 0 — even the control's failing lint returns green.
      breakTool(
        binDir,
        "pnpm",
        `#!/usr/bin/env bash
exit 0
`,
      );
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("FAIL [lint]");
      expect(r.stdout).toContain("control FAILED");
    });
  }, 60_000);

  it("fails (exit 1) when the smoke render fails", () => {
    withSandbox(
      ({ binDir, root, run }) => {
        installGreenToolchain(binDir);
        // Helper copy in the sandbox that always fails (real helper is not
        // exercised here — the REAL end-to-end test below runs it for real).
        writeFileSync(
          path.join(root, "scripts/release/regression-render-smoke.mjs"),
          "console.error('render-smoke: simulated failure'); process.exit(1);\n",
        );
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("FAIL [render-smoke]");
      },
      { omitRemotionNodeModules: false },
    );
  }, 60_000);

  it("fails (exit 1) when remotion/node_modules is missing", () => {
    withSandbox(
      ({ binDir, run }) => {
        installGreenToolchain(binDir);
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("FAIL [render-smoke]");
        expect(r.stdout).toContain("remotion/node_modules missing");
      },
      { omitRemotionNodeModules: true },
    );
  }, 60_000);

  it("exits 2 on an unknown option and prints help on --help", () => {
    withSandbox(({ binDir, root, run }) => {
      installGreenToolchain(binDir);
      const bad = spawnBash(path.join(root, "scripts/release/regression.sh"), ["--wat"], root, {
        ...process.env,
        PATH: sandboxPath(binDir),
      });
      expect(bad.status).toBe(2);
      const help = spawnBash(path.join(root, "scripts/release/regression.sh"), ["--help"], root, {
        ...process.env,
        PATH: sandboxPath(binDir),
      });
      expect(help.status).toBe(2);
      expect(help.stdout).toContain("--skip-render");
    });
  }, 60_000);

  it("carries both recursion guards: --exclude of its own test file + MMCS_REGRESSION_CHILD=1", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("--exclude 'scripts/release/regression.test.ts'");
    expect(src).toContain("MMCS_REGRESSION_CHILD=1");
  });
});

describe("regression.sh — ACCEPTANCE: real repo, real toolchain, one scripted run", () => {
  it("full regression passes in one run: vitest + gen + tsc + lint + 9:16/16:9 smoke + ffprobe", () => {
    // Real script, real repo (this worktree), real toolchain. The vitest area
    // runs the FULL suite (this file excluded); the smoke render exercises
    // the real bundle() → selectComposition() → renderMedia() path and
    // ffprobe-validates both aspect ratios.
    const r = spawnBash(SCRIPT, [], REPO_ROOT, { ...process.env }, 900_000);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PASS [tools]");
    expect(r.stdout).toContain("PASS [vitest]");
    expect(r.stdout).toContain("PASS [gen]");
    expect(r.stdout).toContain("PASS [typecheck]");
    expect(r.stdout).toContain("PASS [lint]");
    expect(r.stdout).toContain("PASS [render-smoke]");
    expect(r.stdout).toContain("regression: PASS");
    // No secrets in output (spec §21: never print secret values).
    expect(r.stdout).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  }, 900_000);
});
