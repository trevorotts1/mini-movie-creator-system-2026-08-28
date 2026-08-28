import { defineConfig } from "vitest/config";

// Local test config for packages/providers/src/kie/seedance/validation.
// Root vitest.config.ts has ESM/CJS mismatch on Node 26 without "type": "module".
export default defineConfig({
  test: {
    include: ["packages/providers/src/kie/seedance/validation/**/*.test.ts"],
    environment: "node",
  },
});
