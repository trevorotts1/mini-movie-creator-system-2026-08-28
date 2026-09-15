import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * SKR-034: without a config of its own this package's `vitest run` loaded the
 * repo-root config, whose `include` patterns name packages/, apps/ and scripts/
 * from the ROOT — so they matched nothing here, the suite reported "No test
 * files found", and the `--passWithNoTests` flag in package.json turned that
 * into a PASS. The package's tests never ran under `pnpm test`.
 *
 * `root` is pinned so the suite resolves identically from this package's cwd,
 * from the worktree root and from the full-repo run. The @mmcs/* aliases mirror
 * vitest.config.ts at the repo root, because this package's tests import the
 * engine workspace packages.
 */
const repo = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@mmcs/capability-registry": path.resolve(repo, "packages/capability-registry/src"),
      "@mmcs/character-library": path.resolve(repo, "packages/character-library/src"),
      "@mmcs/core": path.resolve(repo, "packages/core/src"),
      "@mmcs/cost-engine": path.resolve(repo, "packages/cost-engine/src"),
      "@mmcs/database": path.resolve(repo, "packages/database/src"),
      "@mmcs/domain": path.resolve(repo, "packages/domain/src"),
      "@mmcs/media-storage": path.resolve(repo, "packages/media-storage/src"),
      "@mmcs/prompt-compilers": path.resolve(repo, "packages/prompt-compilers/src"),
      "@mmcs/providers": path.resolve(repo, "packages/providers/src"),
      "@mmcs/qc": path.resolve(repo, "packages/qc/src"),
      "@mmcs/remotion-runtime": path.resolve(repo, "packages/remotion-runtime/src"),
      "@mmcs/scene-intelligence": path.resolve(repo, "packages/scene-intelligence/src"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
    environment: "node",
    // These suites do real SQLite work: migrate, write a row per schema band,
    // export a .mmcsbak, fingerprint the source, restore, and compare
    // checksums. That is ~ms of CPU each in isolation (migrate() measures
    // 2.7-4.3ms across 14 migrations) but the default 5s budget is exceeded
    // when the full 208-file suite runs in parallel — backup.test.ts passes
    // 12/12 in 830ms alone yet two of its cases timed out inside the full run.
    // The assertions here are about correctness, not latency, so the budget is
    // raised rather than the assertions relaxed. Measured, not guessed.
    testTimeout: 20_000,
  },
});
