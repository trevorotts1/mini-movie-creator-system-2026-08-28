// Post-build: place the bin at apps/cli/dist/index.js (the documented path
// clean-install.sh checks) as a re-export shim over the real emitted entry.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const emittedEntry = join(cliRoot, "dist/apps/cli/src/index.js");
const shimPath = join(cliRoot, "dist/index.js");
mkdirSync(dirname(shimPath), { recursive: true });
const rel = (() => {
  // relative path from dist/ to dist/apps/cli/src/index.js
  return "./apps/cli/src/index.js";
})();
writeFileSync(
  shimPath,
  `// bin shim — real entry at dist/apps/cli/src/index.js (rootDir-spanning build)\nexport * from "${rel}";\nimport { main } from "${rel}";\n// This shim IS the bin, so the entry's own invokedDirectly guard can never fire\n// (process.argv[1] is this file while import.meta.url is the real entry). The\n// exit code must therefore be applied here. A non-zero code that a handler\n// assigned to process.exitCode must NOT be clobbered by main()'s parse-level 0,\n// otherwise every verb - including unknown commands - reports success.\nconst code = await main();\nprocess.exitCode = code !== 0 ? code : (process.exitCode ?? 0);\n`,
);
console.log("postbuild: dist/index.js shim written");
