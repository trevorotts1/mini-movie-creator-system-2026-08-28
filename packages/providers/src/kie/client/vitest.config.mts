import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mmcs/core": path.resolve(__dirname, "../../../core/src"),
      "@mmcs/domain": path.resolve(__dirname, "../../../domain/src"),
      "@mmcs/database": path.resolve(__dirname, "../../../database/src"),
      "@mmcs/providers": path.resolve(__dirname, "../../../providers/src"),
      "@mmcs/capability-registry": path.resolve(
        __dirname,
        "../../../capability-registry/src",
      ),
      "@mmcs/prompt-compilers": path.resolve(
        __dirname,
        "../../../prompt-compilers/src",
      ),
      "@mmcs/scene-intelligence": path.resolve(
        __dirname,
        "../../../scene-intelligence/src",
      ),
      "@mmcs/character-library": path.resolve(
        __dirname,
        "../../../character-library/src",
      ),
      "@mmcs/media-storage": path.resolve(__dirname, "../../../media-storage/src"),
      "@mmcs/qc": path.resolve(__dirname, "../../../qc/src"),
      "@mmcs/cost-engine": path.resolve(__dirname, "../../../cost-engine/src"),
      "@mmcs/remotion-runtime": path.resolve(
        __dirname,
        "../../../remotion-runtime/src",
      ),
    },
  },
  test: {
    include: ["packages/providers/src/kie/client/**/*.test.ts"],
    environment: "node",
  },
});
