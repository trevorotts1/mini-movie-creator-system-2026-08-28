import { defineConfig } from "vitest/config";

// Local test config for packages/qc/src/retry.
// Root vitest.config.ts has ESM/CJS mismatch on Node 26 without "type": "module".
export default defineConfig({
  test: {
    include: ["packages/qc/src/retry/**/*.test.ts"],
    environment: "node",
  },
});
