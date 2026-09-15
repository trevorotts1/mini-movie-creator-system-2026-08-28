// SKR-009 tests — the episodic registry must never hide placeholder data.
//
// Defect under test: with no `episodic-plan.json`, the generator silently fell back to
// `episodic-plan.example.json`. The resulting composition rendered a shot-identifying debug
// overlay unconditionally, so a render of placeholder data looked exactly like a successful
// episode render while containing no episode content.
//
// The contract these tests pin:
//   1. A registry built from the example plan is MARKED `placeholder: true` and says so
//      loudly on stderr.
//   2. A registry built from a real plan carries no such flag — so a production render
//      shows no debug overlay.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The generator lives in the standalone remotion/ workspace, which the root vitest config
// does not scan (its include is packages|apps|scripts). The test therefore lives here and
// reaches across, rather than being invisible to the gate.
const REAL_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "remotion",
  "scripts",
  "gen-episodic-registry.mjs",
);

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The real example plan, so the fixture cannot drift from the schema the generator expects. */
const REAL_EXAMPLE_PLAN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "remotion",
  "src",
  "episodic",
  "episodic-plan.example.json",
);

/** A sandbox remotion project: the real generator at its canonical relative path. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-gen-ep-"));
  tmpRoots.push(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "episodic"), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(root, "scripts", "gen-episodic-registry.mjs"));
  fs.copyFileSync(REAL_EXAMPLE_PLAN, path.join(root, "src", "episodic", "episodic-plan.example.json"));
  return { root };
}

/** Promote the example plan to a real plan — the only difference that matters here. */
function useRealPlan(s: { root: string }) {
  const dir = path.join(s.root, "src", "episodic");
  fs.copyFileSync(path.join(dir, "episodic-plan.example.json"), path.join(dir, "episodic-plan.json"));
}

function run(s: { root: string }) {
  // spawnSync, not execFileSync: the warning goes to stderr, and execFileSync only surfaces
  // stderr when the process FAILS — which is exactly the case not being tested here.
  const r = spawnSync("node", [path.join(s.root, "scripts", "gen-episodic-registry.mjs")], {
    cwd: s.root,
    encoding: "utf8",
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const registry = (s: { root: string }) =>
  fs.readFileSync(path.join(s.root, "src", "episodic", "episode-registry.gen.ts"), "utf8");

describe("gen-episodic-registry — placeholder marking (SKR-009)", () => {
  it("marks a registry built from the example plan, and warns on stderr", () => {
    const s = sandbox();
    const r = run(s);
    expect(r.code).toBe(0);
    expect(registry(s)).toContain('"placeholder": true');
    expect(r.stderr).toMatch(/WARNING/);
    expect(r.stderr).toMatch(/PLACEHOLDER/);
    expect(r.stderr).toMatch(/episodic-plan\.example\.json/);
  });

  it("does NOT mark a registry built from a real plan, and does not warn", () => {
    const s = sandbox();
    useRealPlan(s);
    const r = run(s);
    expect(r.code).toBe(0);
    expect(registry(s)).not.toContain('"placeholder"');
    expect(r.stderr).not.toMatch(/WARNING/);
  });

  it("switches the marking off the moment a real plan appears", () => {
    const s = sandbox();
    expect(run(s).code).toBe(0);
    expect(registry(s)).toContain('"placeholder": true');

    useRealPlan(s);
    expect(run(s).code).toBe(0);
    expect(registry(s)).not.toContain('"placeholder"');
  });

  it("still fails when neither plan exists", () => {
    const s = sandbox();
    fs.rmSync(path.join(s.root, "src", "episodic", "episodic-plan.example.json"));
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no episodic-plan\.json/);
  });
});
