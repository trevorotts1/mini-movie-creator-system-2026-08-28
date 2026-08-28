// Dispatcher for the `mmcs` CLI (spec §24, CORE-011 scaffold).
//
// Builds a commander program from the command registry, wires stub handlers
// (feature tasks wire real handlers via `src/commands/<group>.ts` at
// integration), and returns a parse function that is testable without
// spawning a process.

import { Command, CommanderError } from "commander";
import { buildRegistry, mergeSpecs, type CommandSpec } from "./registry.js";
import { stubHandler, wireStub, type Handler, type WiredCommand } from "./stubs.js";

export interface ParseResult {
  exitCode: number;
  error?: string;
}

/** Map of full verb-path name -> real handler, supplied at integration. */
export type HandlerOverrides = Record<string, Handler>;

interface Node {
  spec: CommandSpec; // leaf spec, or synthetic parent spec
  subs: CommandSpec[];
}

/**
 * Build the full commander program from specs. Multi-word verbs
 * ("approve concept", "character show") become nested subcommands — commander
 * does not parse flat space-containing names.
 */
export function buildProgram(
  specs: readonly CommandSpec[],
  overrides: HandlerOverrides = {},
): Command {
  const program = new Command();
  program
    .name("mmcs")
    .description("Mini Movie Creator System — stable, scriptable CLI (spec §24)")
    .exitOverride(); // throw CommanderError instead of process.exit — testable

  // Group specs by first path segment; wire nesting depth-first.
  const nodes = new Map<string, Node>();
  for (const spec of specs) {
    const segments = spec.name.split(" ");
    const head = segments[0] ?? spec.name;
    const rest = segments.slice(1);
    if (rest.length === 0) {
      const existing = nodes.get(spec.name);
      if (existing) existing.spec = spec;
      else nodes.set(spec.name, { spec, subs: [] });
    } else {
      const parent = nodes.get(head);
      if (parent) parent.subs.push(spec);
      else
        nodes.set(head, {
          spec: {
            name: head,
            description: `${head} commands (spec §24)`,
            group: spec.group,
          },
          subs: [spec],
        });
    }
  }

  const wire = (spec: CommandSpec, cmd: Command, path: string[]): void => {
    for (const arg of spec.args ?? []) cmd.argument(arg);
    const handler = overrides[spec.name] ?? stubHandler(spec);
    cmd.action((...positional: unknown[]) => {
      const args: Record<string, string> = {};
      (spec.args ?? []).forEach((ph, i) => {
        const key = ph.replace(/^<|>$/g, "");
        const val = positional[i];
        if (typeof val === "string") args[key] = val;
      });
      void handler(args, {});
    });
  };

  for (const { spec, subs } of nodes.values()) {
    if (subs.length === 0) {
      wire(spec, program.command(spec.name).description(spec.description), [
        spec.name,
      ]);
      continue;
    }
    // Parent group command with subcommands. The parent itself is also a
    // registered verb (spec §24: "providers" AND "providers verify"), so it
    // gets its own handler — bare `mmcs providers` exits 0 with the stub line.
    const parent = program.command(spec.name).description(spec.description);
    wire(spec, parent, [spec.name]);
    for (const sub of subs) {
      const tail = sub.name.split(" ").slice(1).join(" ") || sub.name;
      wire(sub, parent.command(tail).description(sub.description), [
        spec.name,
        tail,
      ]);
    }
  }

  return program;
}

/**
 * Parse + dispatch argv against the program. Returns the intended exit code
 * instead of calling process.exit, so callers (and tests) control termination.
 */
export async function dispatch(
  argv: readonly string[],
  specs: readonly CommandSpec[] = buildRegistry(),
  overrides: HandlerOverrides = {},
): Promise<ParseResult> {
  const program = buildProgram(mergeSpecs(buildRegistry(), specs), overrides);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof CommanderError) {
      // usage errors (--help is 0; unknown command / bad args are 1)
      return {
        exitCode: err.code === "commander.helpDisplayed" ? 0 : err.exitCode,
        error: err.code === "commander.helpDisplayed" ? undefined : err.message,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, error: message };
  }
}

export type { WiredCommand };