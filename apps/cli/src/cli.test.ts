// CORE-011 acceptance tests: command registry + argument parsing for the full
// spec §24 verb list with stub handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram, dispatch } from "./dispatch/dispatcher.js";
import { buildRegistry, mergeSpecs } from "./dispatch/registry.js";
import { stubHandler, stubMessage } from "./dispatch/stubs.js";

/**
 * The exact spec §24 verb list (§24 names, multi-word = nested).
 * Keep in sync with the spec — this test is the drift alarm.
 */
const SPEC_24_VERBS = [
  "doctor",
  "status",
  "create-series",
  "create-episode",
  "develop-concept",
  "approve concept",
  "write-script",
  "approve script",
  "cast",
  "choose-character <candidate>",
  "approve-character <id>",
  "storyboard",
  "approve-storyboard",
  "estimate",
  "generate",
  "generate-shot <id>",
  "retry-shot <id>",
  "qc",
  "rough-cut",
  "approve rough-cut",
  "final",
  "canon review",
  "canon approve",
  "providers",
  "providers verify",
  "models",
  "character list",
  "character show <id>",
  "storage status",
  "recover",
] as const;

describe("command registry (spec §24)", () => {
  it("registers every spec §24 verb with matching name and arity", () => {
    const registry = buildRegistry();
    const names = new Set(registry.map((c) => c.name));
    for (const verb of SPEC_24_VERBS) {
      const tokens = verb.split(" ");
      const argStart = tokens.findIndex((t) => t.startsWith("<"));
      const name =
        argStart === -1 ? verb : tokens.slice(0, argStart).join(" ");
      const expectedArgs =
        argStart === -1 ? [] : tokens.slice(argStart);
      expect(names.has(name), `missing verb: ${name}`).toBe(true);
      const spec = registry.find((c) => c.name === name)!;
      expect(spec.args ?? []).toEqual(expectedArgs);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate verb names", () => {
    const names = buildRegistry().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every spec is in a known group with a description", () => {
    for (const spec of buildRegistry()) {
      expect(spec.group.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("mergeSpecs lets feature tasks override stubs without losing base verbs", () => {
    const base = buildRegistry();
    const overrides = [
      { ...base.find((c) => c.name === "cast")!, description: "REAL cast handler" },
    ];
    const merged = mergeSpecs(base, overrides);
    expect(merged.find((c) => c.name === "cast")!.description).toBe(
      "REAL cast handler",
    );
    expect(merged.length).toBe(base.length);
    expect(merged.find((c) => c.name === "doctor")).toBeDefined();
  });
});

describe("stub handlers", () => {
  it("prints the documented stub line and exits 0", () => {
    const spec = buildRegistry().find((c) => c.name === "doctor")!;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stubHandler(spec)({}, {});
    expect(write).toHaveBeenCalledWith(stubMessage(spec, []) + "\n");
    expect(stubMessage(spec, [])).toContain("[mmcs] doctor — STUB:");
    write.mockRestore();
  });

  it("echoes positional args inertly as data", () => {
    const spec = buildRegistry().find((c) => c.name === "choose-character")!;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stubHandler(spec)({ candidate: "2" }, {});
    const out = String(write.mock.calls.map((c) => c[0]).join(""));
    expect(out).toContain("args: 2");
    write.mockRestore();
  });
});

describe("argument parsing / dispatch", () => {
  it("dispatches every registered verb (and nested verbs) with exit 0", async () => {
    for (const spec of buildRegistry()) {
      const argv = spec.name.split(" ");
      // Supply the required positional args so dispatch succeeds.
      for (const arg of spec.args ?? []) {
        argv.push(arg.replace(/^<|>$/g, "") === "candidate" ? "2" : "id-1");
      }
      const res = await dispatch(argv);
      expect(res.exitCode, `verb ${spec.name} should exit 0`).toBe(0);
      expect(res.error).toBeUndefined();
    }
  });

  it("passes required arguments through to nested verbs", async () => {
    const handler = vi.fn();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await dispatch(["character", "show", "abc-123"], [], {
      "character show": handler,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abc-123" }),
      {},
    );
    write.mockRestore();
  });

  it("passes arguments to flat verbs with <args>", async () => {
    const handler = vi.fn();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await dispatch(["retry-shot", "shot-9"], [], { "retry-shot": handler });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shot-9" }),
      {},
    );
    write.mockRestore();
  });

  it("exits 1 on unknown command with an error message", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const res = await dispatch(["definitely-not-a-verb"]);
    expect(res.exitCode).toBe(1);
    expect(res.error).toBeDefined();
    err.mockRestore();
  });

  it("exits 1 when a required argument is missing", async () => {
    const res = await dispatch(["choose-character"]);
    expect(res.exitCode).toBe(1);
    expect(res.error).toBeDefined();
  });

  it("prints help without error on --help", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const res = await dispatch(["--help"]);
    expect(res.exitCode).toBe(0);
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("mmcs");
    write.mockRestore();
  });

  it("buildProgram nests multi-word verbs (approve concept reachable)", async () => {
    const program = buildProgram(buildRegistry());
    const approve = program.commands.find((c) => c.name() === "approve");
    expect(approve).toBeDefined();
    expect(
      approve!.commands.some((c) => c.name() === "concept"),
    ).toBe(true);
  });
});