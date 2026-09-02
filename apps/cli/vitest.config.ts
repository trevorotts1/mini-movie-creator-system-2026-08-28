import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(dirname, `../../packages/${name}/src`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mmcs\/core$/, replacement: pkg("core") },
      { find: /^@mmcs\/core\/(.*)$/, replacement: `${pkg("core")}/$1` },
      { find: /^@mmcs\/domain$/, replacement: pkg("domain") },
      { find: /^@mmcs\/database$/, replacement: pkg("database") },
      { find: /^@mmcs\/providers$/, replacement: pkg("providers") },
      { find: /^@mmcs\/capability-registry$/, replacement: pkg("capability-registry") },
      { find: /^@mmcs\/capability-registry\/(.*)$/, replacement: `${pkg("capability-registry")}/$1` },
      { find: /^@mmcs\/prompt-compilers$/, replacement: pkg("prompt-compilers") },
      { find: /^@mmcs\/scene-intelligence$/, replacement: pkg("scene-intelligence") },
      { find: /^@mmcs\/scene-intelligence\/(.*)$/, replacement: `${pkg("scene-intelligence")}/$1` },
      { find: /^@mmcs\/character-library$/, replacement: pkg("character-library") },
      { find: /^@mmcs\/media-storage$/, replacement: pkg("media-storage") },
      { find: /^@mmcs\/qc$/, replacement: pkg("qc") },
      { find: /^@mmcs\/cost-engine$/, replacement: pkg("cost-engine") },
      { find: /^@mmcs\/remotion-runtime$/, replacement: pkg("remotion-runtime") },
      { find: /^@mmcs\/remotion-runtime\/(.*)$/, replacement: `${pkg("remotion-runtime")}/$1` },
    ],
  },
  test: {
    environment: "node",
  },
});
