import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@mmcs/core": path.resolve(__dirname, "packages/core/src"),
      "@mmcs/domain": path.resolve(__dirname, "packages/domain/src"),
      "@mmcs/database": path.resolve(__dirname, "packages/database/src"),
      "@mmcs/providers": path.resolve(__dirname, "packages/providers/src"),
      "@mmcs/capability-registry": path.resolve(
        __dirname,
        "packages/capability-registry/src",
      ),
      "@mmcs/prompt-compilers": path.resolve(
        __dirname,
        "packages/prompt-compilers/src",
      ),
      "@mmcs/scene-intelligence": path.resolve(
        __dirname,
        "packages/scene-intelligence/src",
      ),
      "@mmcs/character-library": path.resolve(
        __dirname,
        "packages/character-library/src",
      ),
      "@mmcs/media-storage": path.resolve(__dirname, "packages/media-storage/src"),
      "@mmcs/qc": path.resolve(__dirname, "packages/qc/src"),
      "@mmcs/cost-engine": path.resolve(__dirname, "packages/cost-engine/src"),
      "@mmcs/remotion-runtime": path.resolve(
        __dirname,
        "packages/remotion-runtime/src",
      ),
    },
  },
  test: {
    include: [
      "packages/**/*.{test,spec}.ts",
      "apps/**/*.{test,spec}.ts",
      "scripts/**/*.{test,spec}.ts",
    ],
    environment: "node",
    // These suites shell out to ffmpeg/ffprobe or do real SQLite round-trips.
    // They are milliseconds in isolation but exceed the default 5s budget when
    // all 208 files run in parallel (measured: each of the three files below
    // passes 4-12/12 alone and times out inside the full run). The assertions
    // are about correctness, not latency, so the budget moves rather than the
    // assertions.
    testTimeout: 20_000,
  },
});