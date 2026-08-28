#!/usr/bin/env node
// `mmcs` CLI entry point (spec §24, CORE-011).
//
// Thin bootstrap: registers the command surface from the dispatch registry and
// hands argv to the dispatcher. No business logic lives here — commands are
// stubs until their owning tasks wire real handlers under src/commands/.

import { dispatch } from "./dispatch/dispatcher.js";
import { buildRegistry } from "./dispatch/registry.js";

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  // Registry is built once and kept importable for tests and the API app.
  void buildRegistry;
  const { exitCode, error } = await dispatch(argv);
  if (error) process.stderr.write(`[mmcs] ${error}\n`);
  return exitCode;
}

// Run only when executed directly (not under vitest / import).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[mmcs] unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}