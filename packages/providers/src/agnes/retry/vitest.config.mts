import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local test config for the Agnes retry/idempotency module. The repo-root
// vitest.config.ts is ESM but the root package.json predates "type": "module",
// which breaks config loading on Node 26 (blocker already filed by CORE-013
// for the scaffold owner). Run with:
//   npx vitest run --config packages/providers/src/agnes/retry/vitest.config.mts packages/providers/src/agnes/retry
// ESM-safe: `__dirname` does not exist in an .mts config; use import.meta.
const dirHere = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@mmcs/core": path.resolve(dirHere, "../../../../core/src"),
    },
  },
  test: {
    include: ["packages/providers/src/agnes/retry/**/*.test.ts"],
    environment: "node",
  },
});