import { defineConfig } from "vitest/config";

// Local test config for the idempotency package. The repo-root vitest.config.ts
// is ESM but the root package.json predates "type": "module", which breaks
// config loading on Node 26 (blocker filed for the scaffold owner). Run with:
//   npx vitest run --config packages/core/src/idempotency/vitest.config.mts packages/core/src/idempotency
export default defineConfig({
  test: {
    include: ["packages/core/src/idempotency/**/*.test.ts"],
    environment: "node",
  },
});