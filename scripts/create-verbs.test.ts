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

describe("mmcs create-scene / create-shot (SKR-003)", () => {
  /** Build series → episode, returning the state dir. */
  function withEpisode() {
    const state = freshState();
    cli(state, ["create-series", "--name", "Scene Series"]);
    cli(state, ["create-episode", "--series", "Scene Series", "--title", "Pilot", "--runtime", "6"]);
    return state;
  }

  it("create-scene adds a scene to an existing episode", () => {
    const state = withEpisode();
    const r = cli(state, ["create-scene", "--episode", "S01E01", "--title", "Opening"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scn_/);
    expect(r.out).toContain("Opening");
  });

  it("create-shot adds a shot to an existing scene", () => {
    const state = withEpisode();
    const sceneId = /scn_\w+/.exec(cli(state, ["create-scene", "--episode", "S01E01"]).out)?.[0];
    expect(sceneId).toBeDefined();
    const r = cli(state, ["create-shot", "--scene", sceneId as string, "--duration", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/shot_/);
    expect(r.out).toContain("3s");
  });

  it("FAILS CLOSED when the episode or scene does not exist", () => {
    const state = withEpisode();
    const noEp = cli(state, ["create-scene", "--episode", "S99E99"]);
    expect(noEp.code).toBe(1);
    expect(noEp.out).toContain("S99E99");

    const noScene = cli(state, ["create-shot", "--scene", "scn_nope", "--duration", "3"]);
    expect(noScene.code).toBe(1);
    expect(noScene.out).toContain("scn_nope");
  });

  it("rejects a non-positive --duration instead of storing it", () => {
    const state = withEpisode();
    const sceneId = /scn_\w+/.exec(cli(state, ["create-scene", "--episode", "S01E01"]).out)?.[0];
    const r = cli(state, ["create-shot", "--scene", sceneId as string, "--duration", "0"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/positive number/);
  });

  it("moves `mmcs final` past the no-shots wall to the approval gate", { timeout: 90_000 }, () => {
    // The point of adding scenes and shots: `final` no longer fails because the composition
    // is empty. It now fails on the NEXT real requirement (spec §3.5 needs rough-cut
    // approval), which is a gate doing its job rather than missing data.
    const state = withEpisode();
    const sceneId = /scn_\w+/.exec(cli(state, ["create-scene", "--episode", "S01E01"]).out)?.[0];
    cli(state, ["create-shot", "--scene", sceneId as string, "--duration", "3"]);
    const r = cli(state, ["final", "S01E01"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/GATE_NOT_APPROVED/);
    expect(r.out).not.toMatch(/no shots/);
    // NOTE: this takes tens of seconds because `final` still reads the gate through a
    // SECOND Atomics.wait bridge (finalPorts().approvalsPort in apps/cli/src/index.ts), so
    // each read burns the full 5s timeout before falling back to "PENDING". That bridge is
    // the remaining known defect; the extended timeout is here so this test documents the
    // behaviour instead of flaking, and it should be tightened when the bridge is removed.
  });
});

describe("approval gate verbs (SKR-003)", () => {
  const chain = ["concept", "script", "character", "storyboard", "rough-cut", "canon"];

  it("every gate in the spec §3 order has a verb that PARSES", () => {
    // The registry used a SPACE for concept/script/rough-cut but a HYPHEN for
    // approve-character/approve-storyboard, so `mmcs approve character` died with
    // "too many arguments for 'approve'" and the documented chain could not be walked.
    // This asserts each gate name is at least ACCEPTED as a verb; whether it succeeds is a
    // separate matter (gate order, and the script-bridge defect still open).
    for (const gate of chain) {
      const r = cli(freshState(), ["approve", gate]);
      expect(r.out, `approve ${gate} must not be a parse error`).not.toMatch(/too many arguments/);
      expect(r.out, `approve ${gate} must not be an unknown command`).not.toMatch(/unknown command/);
    }
  });

  it("keeps `approve-character <id>` as its own id-taking verb", () => {
    // It approves a character VERSION, not the character gate — the fix must not have
    // collapsed the two into one.
    const r = cli(freshState(), ["approve-character", "char-1"]);
    expect(r.out).not.toMatch(/too many arguments/);
  });

  it("enforces gate order once the chain is walkable", () => {
    const state = freshState();
    expect(cli(state, ["approve", "concept"]).code).toBe(0);
    // character cannot be approved while script is pending — the §3 state machine working.
    const skip = cli(state, ["approve", "character"]);
    expect(skip.code).toBe(1);
    expect(skip.out).toMatch(/gate order/);
  });
});

describe("gate-2 approval is awaited, not bridged (SKR-003)", () => {
  it("`approve script` SUCCEEDS — it used to be a guaranteed timeout", () => {
    // The port was synchronous and bridged from the async store by spinning on
    // Atomics.wait. That blocks the event loop, so the microtask that assigns the value it
    // waits for can never run: the 5s timeout was guaranteed, not a race. `approve script`
    // could NEVER succeed.
    const state = freshState();
    expect(cli(state, ["approve", "concept"]).code).toBe(0);
    const r = cli(state, ["approve", "script"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/APPROVED/);
    expect(r.out).not.toMatch(/did not respond in time/);
  });

  it("the whole spec §3 chain can be walked in order", () => {
    const state = freshState();
    for (const gate of ["concept", "script", "character", "storyboard", "rough-cut"]) {
      const r = cli(state, ["approve", gate]);
      expect(r.code, `approve ${gate} should succeed: ${r.out}`).toBe(0);
      expect(r.out).toMatch(/APPROVED/);
    }
    // And `status` agrees, which is what makes the walk meaningful.
    const status = cli(state, ["status"]).out;
    expect(status).toMatch(/rough-cut: APPROVED/);
  });
});
