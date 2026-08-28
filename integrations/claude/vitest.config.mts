import { defineConfig } from "vitest/config";

// Local test config for the Claude personal-install wrapper. The repo-root
// vitest.config.ts only includes packages/** and apps/** (root package.json
// predates "type": "module", hence the .mts extension — same pattern as
// integrations/claude/vitest.config.mts from SKL-002 and
// packages/core/src/idempotency/vitest.config.mts). `root` is pinned so the
// suite runs identically from the package cwd (`pnpm -r test`) or the
// worktree root:
//   npx vitest run --config integrations/claude/vitest.config.mts
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
