import { defineConfig } from "vitest/config";
import path from "node:path";

// REL-003 — vitest config for the example project (examples/ is not a pnpm
// workspace member, so the root vitest.config.ts `include` never matches
// here; `npx vitest run examples/demo-series --config examples/vitest.examples.config.ts`
// runs the example's acceptance tests with the same @mmcs/* aliases).
export default defineConfig({
  resolve: {
    alias: {
      "@mmcs/core": path.resolve(__dirname, "../packages/core/src"),
      "@mmcs/domain": path.resolve(__dirname, "../packages/domain/src"),
      "@mmcs/database": path.resolve(__dirname, "../packages/database/src"),
      "@mmcs/capability-registry": path.resolve(__dirname, "../packages/capability-registry/src"),
      "@mmcs/scene-intelligence": path.resolve(__dirname, "../packages/scene-intelligence/src"),
      "@mmcs/character-library": path.resolve(__dirname, "../packages/character-library/src"),
      "@mmcs/media-storage": path.resolve(__dirname, "../packages/media-storage/src"),
      "@mmcs/qc": path.resolve(__dirname, "../packages/qc/src"),
      "@mmcs/cost-engine": path.resolve(__dirname, "../packages/cost-engine/src"),
      "@mmcs/remotion-runtime": path.resolve(__dirname, "../packages/remotion-runtime/src"),
    },
  },
  test: {
    include: ["examples/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
