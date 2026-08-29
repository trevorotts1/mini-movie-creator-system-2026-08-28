import { defineConfig } from "vitest/config";

// Local test config for the REC-010 restart simulation (todo TASK-REC-010).
// The repo-root vitest.config.ts is ESM but the root package.json predates
// "type": "module", which breaks config loading on Node 26 (same blocker the
// idempotency package filed for the scaffold owner). Run with:
//   npx vitest run --config scripts/orchestration/vitest.config.mts scripts/orchestration
export default defineConfig({
  test: {
    include: ["scripts/orchestration/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
