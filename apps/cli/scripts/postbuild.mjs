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
  `// bin shim — real entry at dist/apps/cli/src/index.js (rootDir-spanning build)\nexport * from "${rel}";\nimport { main } from "${rel}";\nawait main();\n`,
);
console.log("postbuild: dist/index.js shim written");
