import { defineConfig } from "vitest/config";

// Local test config for the GHL retry/idempotency module. The repo-root
// vitest.config.ts is ESM but the root package.json predates "type": "module",
// which breaks config loading on Node 26 (blocker already filed by CORE-013
// for the scaffold owner). Run with:
//   npx vitest run --config packages/media-storage/src/ghl/retry/vitest.config.mts packages/media-storage/src/ghl/retry
export default defineConfig({
  test: {
    include: ["packages/media-storage/src/ghl/retry/**/*.test.ts"],
    environment: "node",
  },
});