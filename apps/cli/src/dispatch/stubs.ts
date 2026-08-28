// Stub handler execution for the `mmcs` CLI (spec §24, CORE-011 scaffold).
//
// Every registered verb is runnable from day one: it reports that it is
// registered but not implemented, exits 0, and never touches the filesystem,
// the network, or provider spend. Feature tasks replace the stub by exporting
// a CommandSpec with a `handler` from their `src/commands/<group>.ts` file.

import type { CommandSpec } from "./registry.js";

export type Handler = (
  args: Record<string, string>,
  options: Record<string, unknown>,
) => void | Promise<void>;

/** A spec plus its (stub or real) handler. */
export interface WiredCommand extends CommandSpec {
  handler: Handler;
}

/** Deterministic stub output — asserted by the test suite. */
export function stubMessage(spec: CommandSpec, args: string[]): string {
  const base = `[mmcs] ${spec.name} — STUB: registered, not implemented yet (spec §24).`;
  return args.length > 0 ? `${base} args: ${args.join(", ")}` : base;
}

/**
 * The default stub handler. Prints one line to stdout, exits 0.
 * Story/script text never reaches here as instructions — arguments are only
 * echoed as inert data on stdout (spec §29: untrusted data never executed).
 */
export function stubHandler(spec: CommandSpec): Handler {
  return (args, options) => {
    const positional = Object.values(args).filter(
      (v): v is string => typeof v === "string",
    );
    process.stdout.write(stubMessage(spec, positional) + "\n");
    if (Object.keys(options).length > 0) {
      // Options are echoed inertly so the surface is scriptable/testable.
      process.stdout.write(`[mmcs] ${spec.name} options: ${JSON.stringify(options)}\n`);
    }
  };
}

/** Wrap a spec into a WiredCommand with the stub handler. */
export function wireStub(spec: CommandSpec): WiredCommand {
  return { ...spec, handler: stubHandler(spec) };
}