// SKL-005 install.sh behavioral tests — hermetic: a fake `openclaw` CLI on
// PATH stands in for the real one, so the suite never mutates the operator's
// live OpenClaw workspace. Covers: workspace resolved FROM CONFIG (never
// guessed), current CLI install flow, workspace-placement fallback,
// idempotency, backup-before-overwrite, --check, --uninstall.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const INTEGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const INSTALL_SH = path.join(INTEGRATION_DIR, "install.sh");
const PACKAGING_DIR = path.join(INTEGRATION_DIR, "mini-movie-creator");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-skl005-"));
  tmpDirs.push(d);
  return d;
}

interface Fake {
  bin: string;
  workspace: string;
  sandbox: string;
}

/**
 * Fake `openclaw` CLI:
 * - `config get agents.list` / `agents.defaults.workspace` → served from a
 *   config.json fixture (the ONLY source of workspace truth).
 * - `skills list` → prints the skill row when the state file says installed.
 * - `skills install` → per mode: copy the skill into the workspace (like the
 *   real CLI), fail, or no-op.
 */
function fakeOpenclaw(opts: {
  workspace: string;
  configJson: string;
  installMode?: "copy" | "fail" | "noop";
  /** Every workspace dir the config names (all created on disk). */
  configWorkspaces?: string[];
}): Fake {
  const sandbox = tmp();
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(opts.workspace, { recursive: true });
  // All workspaces named in the config must exist on disk (install.sh checks).
  for (const ws of opts.configWorkspaces ?? []) {
    fs.mkdirSync(ws, { recursive: true });
  }
  const configPath = path.join(sandbox, "config.json");
  fs.writeFileSync(configPath, opts.configJson);
  const statePath = path.join(sandbox, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ installed: false }));
  const mode = opts.installMode ?? "copy";

  const allWorkspaces = Array.from(
    new Set([opts.workspace, ...(opts.configWorkspaces ?? [])]),
  );
  const script = `#!/usr/bin/env bash
STATE="${statePath}"
CONFIG="${configPath}"
WORKSPACES="${allWorkspaces.join(" ")}"
case "$1 $2 $3" in
  "config get agents.list")
    cat "$CONFIG" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['agents']['list']))"
    exit 0 ;;
  "config get agents.defaults.workspace")
    cat "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['agents']['defaults']['workspace'])"
    exit 0 ;;
  "config get agents.defaults")
    cat "$CONFIG" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['agents']['defaults']))"
    exit 0 ;;
  "skills list "*)
    # Mirror the real CLI: a table row per skill with a Source column.
    for ws in $WORKSPACES; do
      for d in "$ws"/skills/*/; do
        if [ -f "$d/SKILL.md" ]; then
          name="$(basename "$d")"
          echo "│ skill     │ $name │ description │ openclaw-workspace     │"
        fi
      done
    done
    # A global/managed-scope install of the same slug (SKL-006's territory).
    if [ -f "$HOME/.openclaw/skills/mini-movie-creator/SKILL.md" ]; then
      echo "│ skill     │ mini-movie-creator │ description │ openclaw-managed       │"
    fi
    exit 0 ;;
  "skills install "*)
    # $4..$N carry the skill-ref and flags; find the source dir argument.
    case "${mode}" in
      copy)
        src=""
        prev=""
        for a in "$@"; do
          case "$prev" in --as|--agent) prev=""; continue ;; esac
          case "$a" in --as|--agent|--force|--acknowledge-clawhub-risk) prev="$a"; continue ;; esac
          case "$a" in /*) src="$a" ;; esac
        done
        dest="$WS/skills/mini-movie-creator"
        rm -rf "$dest"
        cp -R "$src" "$dest"
        echo '{"installed":true}' > "$STATE"
        exit 0 ;;
      fail) exit 1 ;;
      noop) exit 0 ;;
    esac
    ;;
esac
exit 0
`;
  // The workspace path must be visible to the fake script; baked in above.
  fs.writeFileSync(path.join(bin, "openclaw"), script);
  fs.chmodSync(path.join(bin, "openclaw"), 0o755);
  return { bin, workspace: opts.workspace, sandbox };
}

function runInstall(fake: Fake, args: string[]) {
  return spawnSync("bash", [INSTALL_SH, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
  });
}

const CONFIG_TWO_AGENTS = (defaultWs: string, otherWs: string) =>
  JSON.stringify({
    agents: {
      defaults: { workspace: defaultWs },
      list: [
        { id: "main", default: true, workspace: defaultWs },
        { id: "other", default: false, workspace: otherWs },
      ],
    },
  });

describe("SKL-005 install.sh — hermetic behavior", () => {
  it("resolves the active workspace from OpenClaw config (agents.list default), never cwd", () => {
    const defaultWs = path.join(tmp(), "ws-default");
    const otherWs = path.join(tmp(), "ws-other");
    const fake = fakeOpenclaw({
      workspace: defaultWs,
      configJson: CONFIG_TWO_AGENTS(defaultWs, otherWs),
    });
    const r = runInstall(fake, []);
    expect(r.status).toBe(0);
    // Skill landed in the CONFIG-resolved workspace, not cwd-relative guessing.
    expect(fs.existsSync(path.join(defaultWs, "skills/mini-movie-creator/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(otherWs, "skills/mini-movie-creator"))).toBe(false);
    expect(r.stdout).toContain(defaultWs);
  });

  it("--agent targets that agent's workspace from config", () => {
    const defaultWs = path.join(tmp(), "ws-default");
    const otherWs = path.join(tmp(), "ws-other");
    const fake = fakeOpenclaw({
      workspace: defaultWs,
      configJson: CONFIG_TWO_AGENTS(defaultWs, otherWs),
      configWorkspaces: [defaultWs, otherWs],
    });
    const r = runInstall(fake, ["--agent", "other"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(otherWs, "skills/mini-movie-creator/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(defaultWs, "skills/mini-movie-creator"))).toBe(false);
  });

  it("aborts with exit 2 when config defines no workspace (refuses to guess)", () => {
    const sandbox = tmp();
    const bin = path.join(sandbox, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "openclaw"),
      "#!/usr/bin/env bash\nexit 0\n", // answers nothing
    );
    fs.chmodSync(path.join(bin, "openclaw"), 0o755);
    const fake: Fake = { bin, workspace: "", sandbox };
    const r = runInstall(fake, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("never guess");
  });

  it("aborts when the resolved workspace directory does not exist", () => {
    const fake = fakeOpenclaw({
      workspace: path.join(tmp(), "does-not-exist"),
      configJson: CONFIG_TWO_AGENTS(
        path.join(tmp(), "does-not-exist"),
        path.join(tmp(), "x"),
      ),
    });
    const r = runInstall(fake, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not exist");
  });

  it("falls back to workspace placement when the CLI install fails", () => {
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "fail",
    });
    const r = runInstall(fake, []);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("workspace placement");
    expect(fs.existsSync(path.join(ws, "skills/mini-movie-creator/SKILL.md"))).toBe(true);
  });

  it("is idempotent: second run is a no-op (no duplicate, no backup)", () => {
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "noop", // CLI flow does nothing → placement fallback installs
    });
    expect(runInstall(fake, []).status).toBe(0);
    const dest = path.join(ws, "skills/mini-movie-creator");
    const before = fs.statSync(dest).ino;
    const r = runInstall(fake, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
    expect(fs.statSync(dest).ino).toBe(before);
    expect(fs.readdirSync(path.join(ws, "skills")).filter((f) => f.startsWith("mini-movie-creator")).length).toBe(1);
  });

  it("--check exits 0 when installed, 1 when absent", () => {
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "noop",
    });
    const absent = runInstall(fake, ["--check"]);
    expect(absent.status).toBe(1);
    expect(runInstall(fake, []).status).toBe(0);
    const present = runInstall(fake, ["--check"]);
    expect(present.status).toBe(0);
    expect(present.stdout).toContain("OK");
  });

  it("--uninstall removes the skill and --check then reports absent", () => {
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "noop",
    });
    expect(runInstall(fake, []).status).toBe(0);
    const r = runInstall(fake, ["--uninstall"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(ws, "skills/mini-movie-creator"))).toBe(false);
    expect(runInstall(fake, ["--check"]).status).toBe(1);
  });

  it("overwrites when only a reference is stale (tree compare, not just SKILL.md)", () => {
    // Regression: the idempotency check used to diff only SKILL.md, so a
    // packaging update to references/ or scripts/ left the installed copy
    // stale forever. A diverging reference must trigger a refresh.
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "fail", // placement path so we control the write
    });
    const dest = path.join(ws, "skills/mini-movie-creator");
    fs.mkdirSync(path.join(dest, "references"), { recursive: true });
    // SKILL.md identical, but one reference diverges.
    fs.copyFileSync(
      path.join(PACKAGING_DIR, "SKILL.md"),
      path.join(dest, "SKILL.md"),
    );
    fs.writeFileSync(path.join(dest, "references/workflow.md"), "stale workflow reference");
    const r = runInstall(fake, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backed up");
    expect(
      fs.readFileSync(path.join(dest, "references/workflow.md"), "utf8"),
    ).not.toContain("stale workflow reference");
  });

  it("backs up a stale existing install before overwriting", () => {
    const ws = path.join(tmp(), "ws");
    const fake = fakeOpenclaw({
      workspace: ws,
      configJson: CONFIG_TWO_AGENTS(ws, ws),
      installMode: "fail", // force the placement path so we control the write
    });
    const dest = path.join(ws, "skills/mini-movie-creator");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "stale content");
    const r = runInstall(fake, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backed up");
    // Fresh content replaced the stale file.
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).not.toContain("stale content");
    // And a backup dir exists OUTSIDE skills/ (a .bak inside skills/ shadows
    // the live install in `openclaw skills info` — the watcher scans every
    // directory with a SKILL.md there).
    expect(
      fs
        .readdirSync(path.join(ws, ".mmcs-skill-backups"))
        .some((f) => f.startsWith("mini-movie-creator.bak-")),
    ).toBe(true);
    // skills/ contains ONLY the live install.
    expect(fs.readdirSync(path.join(ws, "skills")).filter((f) => f.startsWith("mini-movie-creator")).length).toBe(1);
  });
});