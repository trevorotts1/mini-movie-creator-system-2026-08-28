import { defineConfig } from "vitest/config";

/**
 * SKR-034: without a config of its own, `vitest run` from this package's cwd
 * loads the repo-root vitest.config.ts, whose `include` patterns are
 * root-relative (they name packages/, apps/ and scripts/ from the repo root)
 * and therefore match NOTHING here — the suite reported "No test files found"
 * and the `--passWithNoTests` flag that used to sit in package.json turned
 * that into a PASS.
 *
 * `root` is pinned so the suite resolves identically from this package's cwd
 * (`pnpm -r test`), from the worktree root, and from the full-repo run — the
 * same pattern integrations/claude/vitest.config.mts documents.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
