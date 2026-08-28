import { defineConfig } from "vitest/config";

// Local test config for QC-003 wardrobe/hair/prop checks.
export default defineConfig({
  test: {
    include: ["packages/qc/src/wardrobe/**/*.test.ts"],
    environment: "node",
  },
});
