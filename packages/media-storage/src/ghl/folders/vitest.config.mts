import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/media-storage/src/ghl/folders/**/*.test.ts"],
    environment: "node",
  },
});
