import { defineConfig } from "vitest/config";

// Local test config for orchestration tests.
// Run with:
//   npx vitest run --config scripts/orchestration/vitest.config.mts scripts/orchestration
export default defineConfig({
  test: {
    include: ["scripts/orchestration/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
