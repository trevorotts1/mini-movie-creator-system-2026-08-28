/**
 * REL-003 — the demo series is drivable through the CLI surface itself:
 * `mmcs create-series` and `mmcs create-episode` are REGISTERED verbs with
 * real parsers (CORE-011 wires handlers; this task only proves the example
 * project's two entry verbs parse and exit 0, never crash).
 *
 * Deep-imports the dispatcher by relative path (apps/cli is not a workspace
 * alias target); apps/cli is never edited by this task.
 */
import { describe, expect, it } from "vitest";

import { dispatch } from "../../apps/cli/src/dispatch/dispatcher.js";
import { stubMessage } from "../../apps/cli/src/dispatch/stubs.js";
import { buildRegistry } from "../../apps/cli/src/dispatch/registry.js";

describe("demo series — CLI entry verbs", () => {
  it("registers create-series and create-episode in the spec-24 registry", () => {
    const registry = buildRegistry();
    for (const verb of ["create-series", "create-episode"]) {
      const spec = registry.find((c) => c.name === verb);
      expect(spec, `missing verb: ${verb}`).toBeTruthy();
      expect(spec?.description.length).toBeGreaterThan(0);
    }
  });

  it("mmcs create-series parses clean (CORE-011 handler still STUB)", async () => {
    const result = await dispatch(["create-series"]);
    expect(result.exitCode).toBe(0);
  });

  it("mmcs create-episode parses clean (CORE-011 handler still STUB)", async () => {
    const result = await dispatch(["create-episode"]);
    expect(result.exitCode).toBe(0);
  });

  it("stub handler announces itself instead of pretending to work", () => {
    const spec = buildRegistry().find((c) => c.name === "create-series")!;
    const message = stubMessage(spec, []);
    expect(message).toContain("[mmcs]");
    expect(message).toContain("create-series");
  });

  it("unknown verb exits 1 with an error", async () => {
    const result = await dispatch(["start-tuesday-club"]);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
  });

  it("--help exits 0", async () => {
    const result = await dispatch(["--help"]);
    expect(result.exitCode).toBe(0);
  });
});