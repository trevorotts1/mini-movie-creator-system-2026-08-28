// SKR-003 — `create-series` and `create-episode` were fail-closed stubs, which is why no
// episode could ever exist for `mmcs final` to render. The render port was real; there was
// simply nothing to point it at.
//
// These verbs are repository writes: no provider is contacted and nothing is spent. The
// tests drive the REAL CLI, because `dispatch()` in the unit harness falls back to stub
// handlers and would have exercised the stubs instead of the implementations.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Run the real CLI against an isolated state dir. Returns combined output + exit code. */
function cli(stateDir: string, args: string[]) {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", path.join(REPO, "apps", "cli", "src", "index.ts"), ...args],
      { cwd: REPO, encoding: "utf8", env: { ...process.env, MMCS_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const freshState = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-create-"));
  dirs.push(d);
  return d;
};

describe("mmcs create-series / create-episode (SKR-003)", () => {
  it("create-series creates a project and a series, and reports both ids", () => {
    const state = freshState();
    const r = cli(state, ["create-series", "--name", "Test Series"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/project: proj_/);
    expect(r.out).toMatch(/series:\s+ser_/);
    expect(r.out).toContain("Test Series");
    expect(r.out).toContain("16:9"); // documented default
  });

  it("create-episode creates an episode in the named series and returns its code", () => {
    const state = freshState();
    cli(state, ["create-series", "--name", "Test Series"]);
    const r = cli(state, ["create-episode", "--series", "Test Series", "--title", "Pilot", "--runtime", "30"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("S01E01");
    expect(r.out).toMatch(/episode: ep_/);
  });

  it("create-episode accepts a series ID as well as a name", () => {
    const state = freshState();
    const seriesId = /series:\s+(ser_\w+)/.exec(cli(state, ["create-series", "--name", "By Id"]).out)?.[1];
    expect(seriesId).toBeDefined();
    const r = cli(state, ["create-episode", "--series", seriesId as string, "--title", "Pilot"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("S01E01");
  });

  it("honours --season and --number in the episode code", () => {
    const state = freshState();
    cli(state, ["create-series", "--name", "Seasoned"]);
    const r = cli(state, ["create-episode", "--series", "Seasoned", "--title", "Later", "--season", "2", "--number", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("S02E03");
  });

  it("FAILS CLOSED with guidance when a required flag is missing", () => {
    const state = freshState();
    const noName = cli(state, ["create-series"]);
    expect(noName.code).toBe(1);
    expect(noName.out).toMatch(/--name is required/);

    const noTitle = cli(state, ["create-episode", "--series", "whatever"]);
    expect(noTitle.code).toBe(1);
    expect(noTitle.out).toMatch(/--title and --series are required/);
  });

  it("FAILS CLOSED when the series does not exist, naming the input", () => {
    const state = freshState();
    const r = cli(state, ["create-episode", "--series", "no-such-series", "--title", "Pilot"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no-such-series");
  });

  it("rejects a non-numeric --season rather than silently defaulting", () => {
    const state = freshState();
    cli(state, ["create-series", "--name", "Numeric"]);
    const r = cli(state, ["create-episode", "--series", "Numeric", "--title", "X", "--season", "abc"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/positive integers/);
  });

  it("moves `mmcs final` past the missing-episode wall (the point of the fix)", () => {
    // Before this change `final` could not get anywhere: no episode could exist. It now
    // reaches spec validation and fails there for the *right* reason — the episode has no
    // shots yet, because storyboard generation is a separate step.
    const state = freshState();
    cli(state, ["create-series", "--name", "Renderable"]);
    cli(state, ["create-episode", "--series", "Renderable", "--title", "Pilot", "--runtime", "6"]);
    const r = cli(state, ["final", "S01E01"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/INVALID_SPEC/);
    expect(r.out).toMatch(/no shots/);
    // The old failure said the episode did not exist at all.
    expect(r.out).not.toMatch(/not found|does not exist|unknown episode/i);
  });
});
