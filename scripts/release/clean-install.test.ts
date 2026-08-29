// REL-001 tests — scripts/release/clean-install.sh (acceptance: fresh clean
// clone → install → `mmcs doctor` exits 0; no secrets required; script exits 0
// on a pristine clone).
//
// Strategy: each test builds a SANDBOX repo in a temp dir with the required
// monorepo layout plus a COPY of the real script at the same relative path
// (the script anchors REPO_ROOT to its own location, so sandbox runs must run
// the sandbox copy). A fake `pnpm` on the sandbox PATH simulates the
// install/build side effects — the real network install is not repeated per
// test. The pristine end-to-end case IS exercised for real in the final test:
// the real script runs against the real worktree with the real toolchain.

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
const SCRIPT = path.join(REPO_ROOT, "scripts/release/clean-install.sh");

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

/** PATH: system dirs + sandbox bin dir (fake pnpm/node when installed). */
function sandboxPath(binDir: string): string {
  return `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`;
}

/** Build a sandbox repo root with the layout the script checks, plus a copy
 * of the script at the same relative path (REPO_ROOT anchors to the script). */
function makeSandboxRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mmcs-clean-install-"));
  mkdirSync(path.join(root, "apps/cli"), { recursive: true });
  mkdirSync(path.join(root, "packages/core"), { recursive: true });
  mkdirSync(path.join(root, "scripts/release"), { recursive: true });
  copyFileSync(SCRIPT, path.join(root, "scripts/release/clean-install.sh"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "mmcs-monorepo",
      packageManager: "pnpm@11.24.0",
      engines: { node: ">=20" },
    }),
  );
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n  - apps/*\n  - integrations/*\n",
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(root, ".env.example"), "AGNES_API_KEY=\nKIE_API_KEY=\n");
  return root;
}

/** Sandbox context: fake repo + sandbox script path + PATH + cleanup. */
function withSandbox(
  fn: (root: string, binDir: string, run: (args?: string[], env?: NodeJS.ProcessEnv) => RunResult) => void,
): void {
  const root = makeSandboxRepo();
  const binDir = mkdtempSync(path.join(tmpdir(), "mmcs-bin-"));
  const sandboxScript = path.join(root, "scripts/release/clean-install.sh");
  const baseEnv = { ...process.env, PATH: sandboxPath(binDir) };
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}): RunResult =>
    spawnBash(sandboxScript, args, root, { ...baseEnv, ...env });
  try {
    fn(root, binDir, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Fake pnpm shim: simulates install + CLI build side effects, logs args. */
function makeFakePnpm(binDir: string): void {
  writeFileSync(path.join(binDir, "pnpm"), fakePnpmBody(), { mode: 0o755 });
}

/** Fake pnpm shim body — shared by makeFakePnpm and the fake-corepack shim. */
function fakePnpmBody(): string {
  return `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "11.24.0"; exit 0; fi
if [ "$1" = "--filter" ]; then
  mkdir -p apps/cli/dist
  echo 'console.log("[mmcs] fake cli")' > apps/cli/dist/index.js
  exit 0
fi
if [ "$1" = "install" ]; then
  shift
  echo "INSTALL_ARGS:$*" >> fake-pnpm.log
  mkdir -p node_modules/.pnpm
  exit 0
fi
exit 0
`;
}

/** Fake corepack implementing the real `enable --install-directory DIR`
 * contract (writes a working pnpm shim into DIR). `prepare --activate` is a
 * no-op with no PATH effect — exactly like the real corepack, which is why
 * the script must use enable --install-directory, not prepare. */
function makeFakeCorepack(binDir: string): void {
  const body = fakePnpmBody();
  const corepack = `#!/usr/bin/env bash
if [ "$1" = "enable" ]; then
  shift
  dir=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--install-directory" ]; then dir="$2"; shift 2; else shift; fi
  done
  if [ -n "$dir" ]; then
    mkdir -p "$dir"
    printf '%s' '${body.replace(/'/g, "'\\''")}' > "$dir/pnpm"
    chmod +x "$dir/pnpm"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "prepare" ]; then exit 0; fi
exit 0
`;
  writeFileSync(path.join(binDir, "corepack"), corepack, { mode: 0o755 });
}

/** Fake node shim reporting a controllable version for the node-floor check. */
function makeFakeNode(binDir: string, major: string): void {
  writeFileSync(
    path.join(binDir, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo "${major}"; exit 0; fi
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
}

describe("clean-install.sh — usage", () => {
  it("exits 2 with usage on an unknown option", () => {
    withSandbox((_root, _binDir, run) => {
      const r = run(["--nope"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("unknown option");
    });
  });

  it("--help prints the header help and exits 2", () => {
    withSandbox((_root, _binDir, run) => {
      const r = run(["--help"]);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("clean-install.sh");
    });
  });
});

describe("clean-install.sh — prerequisites gate", () => {
  it("fails before mutating when node is below the engines floor", () => {
    withSandbox((root, binDir, run) => {
      makeFakeNode(binDir, "18"); // below engines floor
      makeFakePnpm(binDir); // pnpm WOULD succeed — the gate must abort anyway
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("node >= 20");
      // Regression: the script must NOT proceed to install after a failed
      // hard gate (docs: "aborts with a fix hint BEFORE any mutation").
      expect(existsSync(path.join(root, "fake-pnpm.log"))).toBe(false);
      expect(existsSync(path.join(root, "node_modules"))).toBe(false);
      expect(existsSync(path.join(root, ".env"))).toBe(false);
    });
  });

  it("aborts before mutating when a repo-layout file is missing", () => {
    withSandbox((root, binDir, run) => {
      makeFakePnpm(binDir);
      rmSync(path.join(root, "pnpm-lock.yaml")); // fails the layout gate
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("missing: pnpm-lock.yaml");
      expect(existsSync(path.join(root, "fake-pnpm.log"))).toBe(false);
      expect(existsSync(path.join(root, ".env"))).toBe(false);
    });
  });

  it("fails when ffmpeg/ffprobe are missing from PATH", () => {
    withSandbox((root, binDir, run) => {
      makeFakeNode(binDir, "26");
      // PATH without any ffmpeg: restrict to sandbox bin + core dirs.
      const rootOnly = makeSandboxRepo(); // unused; keeps helper count symmetric
      rmSync(rootOnly, { recursive: true, force: true });
      const r = spawnBash(
        path.join(root, "scripts/release/clean-install.sh"),
        [],
        root,
        { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("ffmpeg/ffprobe missing");
      expect(existsSync(path.join(root, "node_modules"))).toBe(false);
    });
  });
});

describe("clean-install.sh — repo layout gate", () => {
  it("fails on a directory that is not the MMCS monorepo", () => {
    // The script installs ITS OWN repo (REPO_ROOT from the script location),
    // never the cwd — run the sandbox copy inside a repo missing the layout.
    const fakeRepo = mkdtempSync(path.join(tmpdir(), "mmcs-not-repo-"));
    const binDir = mkdtempSync(path.join(tmpdir(), "mmcs-bin-"));
    try {
      mkdirSync(path.join(fakeRepo, "scripts/release"), { recursive: true });
      copyFileSync(SCRIPT, path.join(fakeRepo, "scripts/release/clean-install.sh"));
      makeFakeNode(binDir, "26");
      const r = spawnBash(
        path.join(fakeRepo, "scripts/release/clean-install.sh"),
        [],
        fakeRepo,
        { ...process.env, PATH: sandboxPath(binDir) },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("missing: apps/cli");
      // No install/env mutation happened in the malformed repo.
      expect(existsSync(path.join(fakeRepo, ".env"))).toBe(false);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("clean-install.sh — pristine-clone happy path (fake toolchain)", () => {
  it("exits 0 and performs install → build → doctor → env scaffold", () => {
    withSandbox((root, binDir, run) => {
      makeFakePnpm(binDir);
      const r = run();
      expect(r.status).toBe(0);
      // Install used the frozen lockfile.
      const log = readFileSync(path.join(root, "fake-pnpm.log"), "utf8");
      expect(log).toContain("--frozen-lockfile");
      // CLI build artifact exists.
      expect(existsSync(path.join(root, "apps/cli/dist/index.js"))).toBe(true);
      // Env scaffolded from .env.example, values still blank.
      expect(existsSync(path.join(root, ".env"))).toBe(true);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toContain("AGNES_API_KEY=");
      // No secret values printed anywhere (names only).
      expect(r.stdout).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(r.stdout).toContain("clean-install: OK");
    });
  });

  it("never overwrites an existing .env and never echoes its values", () => {
    withSandbox((root, binDir, run) => {
      makeFakePnpm(binDir);
      writeFileSync(path.join(root, ".env"), "AGNES_API_KEY=operator-real-value\n");
      const r = run();
      expect(r.status).toBe(0);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toBe(
        "AGNES_API_KEY=operator-real-value\n",
      );
      expect(r.stdout).not.toContain("operator-real-value");
    });
  });

  it("--no-env-copy skips the env scaffold", () => {
    withSandbox((root, binDir, run) => {
      makeFakePnpm(binDir);
      const r = run(["--no-env-copy"]);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(root, ".env"))).toBe(false);
    });
  });

  it("--json emits one JSON summary line with no secret values", () => {
    withSandbox((_root, binDir, run) => {
      makeFakePnpm(binDir);
      const r = run(["--json"]);
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split("\n");
      const last = lines[lines.length - 1];
      expect(() => JSON.parse(last)).not.toThrow();
      const parsed = JSON.parse(last) as { status: string; fail: number; pass: number };
      expect(parsed.status).toBe("ok");
      expect(parsed.fail).toBe(0);
      expect(parsed.pass).toBeGreaterThan(0);
    });
  });

  it("falls back to corepack enable --install-directory when pnpm is missing", () => {
    // Regression: the original fallback used `corepack prepare --activate`,
    // which does NOT put a pnpm shim on PATH (verified against real corepack
    // 0.34 — `command -v pnpm` still failed after prepare --activate).
    withSandbox((root, binDir, run) => {
      makeFakeCorepack(binDir); // corepack present, pnpm absent from PATH
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("activated via corepack");
      // The corepack-provisioned shim actually ran install + build.
      const log = readFileSync(path.join(root, "fake-pnpm.log"), "utf8");
      expect(log).toContain("--frozen-lockfile");
      expect(existsSync(path.join(root, "apps/cli/dist/index.js"))).toBe(true);
      expect(existsSync(path.join(root, ".env"))).toBe(true);
    });
  });

  it("MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE=1 drops --frozen-lockfile", () => {
    withSandbox((root, binDir, run) => {
      makeFakePnpm(binDir);
      const res = run([], { MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE: "1" });
      expect(res.status).toBe(0);
      const log = readFileSync(path.join(root, "fake-pnpm.log"), "utf8");
      expect(log).not.toContain("--frozen-lockfile");
    });
  });
});

describe("clean-install.sh — failure surfacing", () => {
  it("exits 1 when pnpm install fails (exit code, not a crash)", () => {
    withSandbox((root, binDir, run) => {
      const pnpm = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "11.24.0"; exit 0; fi
if [ "$1" = "install" ]; then echo "simulated install failure" >&2; exit 1; fi
if [ "$1" = "--filter" ]; then mkdir -p apps/cli/dist; echo 'console.log(1)' > apps/cli/dist/index.js; exit 0; fi
exit 0
`;
      writeFileSync(path.join(binDir, "pnpm"), pnpm, { mode: 0o755 });
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("pnpm install failed");
      // Build/doctor must NOT have run after a failed install.
      expect(existsSync(path.join(root, "apps/cli/dist/index.js"))).toBe(false);
      expect(existsSync(path.join(root, ".env"))).toBe(false);
    });
  });

  it("exits 1 when the CLI build fails", () => {
    withSandbox((root, binDir, run) => {
      const pnpm = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "11.24.0"; exit 0; fi
if [ "$1" = "install" ]; then mkdir -p node_modules/.pnpm; exit 0; fi
if [ "$1" = "--filter" ]; then exit 1; fi
exit 0
`;
      writeFileSync(path.join(binDir, "pnpm"), pnpm, { mode: 0o755 });
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("CLI build failed");
      expect(existsSync(path.join(root, ".env"))).toBe(false);
    });
  });

  it("exits 1 when the built CLI (doctor) exits non-zero", () => {
    withSandbox((_root, binDir, run) => {
      // The "built CLI" exits 7 to simulate a failing doctor.
      const pnpm = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "11.24.0"; exit 0; fi
if [ "$1" = "install" ]; then mkdir -p node_modules/.pnpm; exit 0; fi
if [ "$1" = "--filter" ]; then mkdir -p apps/cli/dist; printf '#!/usr/bin/env bash\\nexit 7\\n' > apps/cli/dist/index.js; chmod +x apps/cli/dist/index.js; exit 0; fi
exit 0
`;
      writeFileSync(path.join(binDir, "pnpm"), pnpm, { mode: 0o755 });
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("doctor exited non-zero");
    });
  });
});

describe("clean-install.sh — ACCEPTANCE: pristine clone, real toolchain", () => {
  it("real repo + real pnpm: installs, builds, and mmcs doctor exits 0 with no secrets", () => {
    // Runs the REAL script against THIS repo (a git worktree of a clean
    // branch — content-identical to a fresh clone). Real pnpm, real build,
    // real doctor. Doctor needs no secrets: a clean clone passes with an
    // empty .env (CORE-010 lenient loader reports missing keys, never throws).
    const r = spawnBash(SCRIPT, [], REPO_ROOT, { ...process.env }, 600_000);
    const out = r.stdout;
    if (r.status !== 0) console.error(out, r.stderr); // surface on failure
    expect(r.status).toBe(0);
    expect(out).toContain("pnpm install --frozen-lockfile");
    expect(out).toContain("apps/cli/dist/index.js");
    expect(out).toContain("doctor — exit 0");
    expect(existsSync(path.join(REPO_ROOT, "apps/cli/dist/index.js"))).toBe(true);
    // Acceptance: no secrets required — output carries no key values.
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  }, 600_000);
});
