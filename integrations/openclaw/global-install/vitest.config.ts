import { defineConfig } from "vitest/config";

// SKL-006 local vitest config — the root vitest.config.ts `include` covers
// packages/** and apps/** only (shared file, not edited by builders), so the
// integration/openclaw tests run through this config. See
// state/task-updates/SKL-006.builder.json blockers for the merger note.
export default defineConfig({
  test: {
    environment: "node",
    // The end-to-end cases shell out to the real `openclaw` CLI (~2-4s each);
    // keep the default 5s per-test timeout generous but bounded.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
