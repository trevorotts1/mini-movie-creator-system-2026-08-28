import { defineConfig } from "vitest/config";

// Local test config for @mmcs/providers/agnes/profiles/regular.
// Root vitest.config.ts has ESM/CJS mismatch on Node 26 without "type": "module".
export default defineConfig({
  test: {
    include: ["packages/providers/src/agnes/profiles/regular/**/*.test.ts"],
    environment: "node",
  },
});
