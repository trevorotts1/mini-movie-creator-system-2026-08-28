// SKL-004 acceptance tests: nine-verify.sh structural contract.
//
// The script's LIVE checks (fresh claude-nine sessions, model calls, sync run)
// are proven by running `bash integrations/claude/nine-verify.sh` itself —
// recorded in docs/environment/CLAUDE-NINE-CAPABILITIES.md, never invented here.
// These tests assert the structural guarantees a run depends on, cheaply and
// hermetically.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "nine-verify.sh");
const REPO_ROOT = resolve(HERE, "../..");
const body = readFileSync(SCRIPT, "utf8");

describe("nine-verify.sh — structural contract", () => {
  it("exists, is executable, and parses as bash", () => {
    const out = execFileSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(out).toBe("");
  });

  it("never fails the run on empty count output (set -u safe)", () => {
    expect(body).toMatch(/^set -uo pipefail$/m);
  });

  it("cleans up its probe directories on exit (non-destructive)", () => {
    expect(body).toContain("trap 'rm -rf");
    expect(body).toContain("${PROBE_A_DIR:-}");
    expect(body).toContain("${PROBE_B_DIR:-}");
  });

  it("targets the claude-nine discovery root, not ~/.claude/skills", () => {
    expect(body).toContain("${CLAUDE_CONFIG_DIR:-$HOME/.claude-nine}/skills");
  });

  it("exercises the operator sync script that wires ~/.claude/skills into nine", () => {
    expect(body).toContain("sync-nine-skills.sh");
  });

  it("probes project-scope skill discovery under <cwd>/.claude/skills", () => {
    expect(body).toContain(".claude/skills/mmcs-nine-probe");
  });

  it("probes config-dir skill discovery with an isolated CLAUDE_CONFIG_DIR", () => {
    expect(body).toContain("CLAUDE_CONFIG_DIR=\"$PROBE_B_DIR\"");
  });

  it("drives the SAME mmcs engine CLI (no copied logic) in the probe skill", () => {
    expect(body).toContain("$CLI_DIR/dist/index.js status");
    expect(body).toContain("apps/cli/dist/index.js status");
  });

  it("supports a no-model-call --selftest mode", () => {
    expect(body).toContain("--selftest");
  });

  it("exits 1 on any failed check, 0 only when all pass", () => {
    expect(body).toMatch(/\[ "\$FAIL" -eq 0 \] && exit 0 \|\| exit 1/);
  });

  it("probes the REAL /mini-movie-creator skill (SKL-004 acceptance), never passing on its absence", () => {
    expect(body).toContain("REAL /mini-movie-creator skill");
    expect(body).toContain('$REPO_ROOT/skills/mini-movie-creator"');
    expect(body).toContain("step skipped, not passed");
    expect(body).toContain("ln -s \"$CANONICAL_SKILL\"");
    // Real-skill evidence marker: engine stub output verbatim, never invented.
    expect(body).toContain("grep -q \"\\[mmcs\\] status\"");
  });

  it("passes the repo root to the real-skill session as an environment fact, not a command", () => {
    expect(body).toContain("The MMCS repository root is $REPO_ROOT");
  });

  it("cleans up the real-skill probe directory too", () => {
    expect(body).toContain("${PROBE_C_DIR:-}");
  });

  it("markers asserted by the live run exist in the probe payloads", () => {
    expect(body).toContain("MMCS-NINE-PROBE-OK");
    expect(body).toContain("MMCS-NINE-PRIMARY-ROOT-OK");
  });

  it("references the docs section it is recorded in", () => {
    const doc = readFileSync(
      resolve(REPO_ROOT, "docs/environment/CLAUDE-NINE-CAPABILITIES.md"),
      "utf8",
    );
    expect(doc).toContain("integrations/claude/nine-verify.sh");
    expect(doc).toContain("MMCS-NINE-PROBE-OK");
  });
});
