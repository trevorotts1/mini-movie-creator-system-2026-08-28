#!/usr/bin/env node
/**
 * Package entry-point guard (SKR-012 / SKR-043 class).
 *
 * Defect: `@mmcs/media-storage` had 65 source files and `@mmcs/providers` had 164, yet both
 * packages' `src/index.ts` contained a SINGLE line exporting a scaffold-marker string. The
 * implementations sat in subdirectories reachable only through the package `./*` subpath
 * export, so `import { archiveHostedUrl } from "@mmcs/media-storage"` resolved successfully
 * to a module exporting one string. TypeScript does not error on that; the import is simply
 * undefined at use time. That is a silent no-op, and it is invisible in review.
 *
 * A marker export is not itself wrong — every package in this repo exports one, and several
 * pair it with real re-exports. The defect is a marker-ONLY entry point on a package that
 * has substantial source behind it.
 *
 * Rule: a package whose `src/` holds more than MIN_SOURCES non-test TypeScript files must
 * have at least one real re-export in `src/index.ts`.
 *
 * Usage:
 *   node scripts/release/package-entry-check.mjs [--json] [--min-sources N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const minIdx = args.indexOf('--min-sources');
const MIN_SOURCES = minIdx >= 0 ? Number(args[minIdx + 1]) : 5;

/** Count non-test .ts files under a directory, recursively. */
function countSources(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countSources(p);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) n += 1;
  }
  return n;
}

/** Real re-exports reachable from the entry point (not the marker constant). */
function reExports(source) {
  return [
    ...source.matchAll(/^\s*export\s+\*\s+as\s+\w+\s+from\s+["'][^"']+["']/gm),
    ...source.matchAll(/^\s*export\s+\*\s+from\s+["'][^"']+["']/gm),
    ...source.matchAll(/^\s*export\s+\{[^}]*\}\s+from\s+["'][^"']+["']/gms),
  ].map((m) => m[0].trim().split(/\s+/).slice(0, 3).join(' '));
}

export function scanPackageEntries(repoRoot = REPO, minSources = MIN_SOURCES) {
  const pkgDir = path.join(repoRoot, 'packages');
  const results = [];
  if (!fs.existsSync(pkgDir)) return { results, failing: [] };

  for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(pkgDir, entry.name, 'src');
    const indexPath = path.join(srcDir, 'index.ts');
    if (!fs.existsSync(indexPath)) continue;
    const sources = countSources(srcDir);
    const source = fs.readFileSync(indexPath, 'utf8');
    const re = reExports(source);
    const markerOnly = re.length === 0;
    results.push({
      name: entry.name,
      sources,
      reExports: re.length,
      markerOnly,
      // Only a marker-ONLY entry over substantial source is a defect.
      verdict: markerOnly && sources > minSources ? 'MARKER_ONLY_ENTRY' : 'OK',
    });
  }

  return { results, failing: results.filter((r) => r.verdict !== 'OK'), minSources };
}

function main() {
  const { results, failing, minSources } = scanPackageEntries();
  const guarded = results.filter((r) => r.sources > minSources).length;

  if (JSON_OUT) {
    process.stdout.write(
      JSON.stringify({ packages: results.length, guarded, minSources, failing }, null, 2) + '\n',
    );
  } else {
    console.log(
      `package-entry: ${results.length} package(s) with an entry point; ${guarded} over the ` +
        `${minSources}-source threshold checked for a real re-export`,
    );
    if (failing.length) {
      console.error(`package-entry: ${failing.length} package(s) export ONLY a scaffold marker:`);
      for (const f of failing) {
        console.error(
          `  - @mmcs/${f.name}: ${f.sources} source files, 0 re-exports in src/index.ts — ` +
            `a root import resolves to a module exporting one string (silent no-op)`,
        );
      }
    } else {
      console.log('package-entry: every package with substantial source re-exports it');
    }
  }

  process.exit(failing.length ? 1 : 0);
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
})();
if (invokedDirectly) main();
