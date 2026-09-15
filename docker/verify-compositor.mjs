#!/usr/bin/env node
/**
 * Build-time assertion that the LINUX Remotion compositor is installed (SKR-033).
 *
 * `@remotion/renderer` declares its per-platform binary as an OPTIONAL dependency. An
 * install that skips optional deps produces a perfectly happy tree with no compositor, and
 * the failure only appears at render time as an opaque error. This runs during `docker
 * build`, so the image fails to build — naming the missing package — instead.
 */
import fs from 'node:fs';

const dir = '/app/remotion/node_modules/@remotion';
const suffix = `${process.platform === 'linux' ? 'linux' : process.platform}-${process.arch}`;
const musl = fs.existsSync('/etc/alpine-release');
const want = `compositor-${suffix}-${musl ? 'musl' : 'gnu'}`;

let present = [];
try {
  present = fs.readdirSync(dir).filter((d) => d.startsWith('compositor-'));
} catch (err) {
  console.error(`cannot read ${dir}: ${err.message}`);
  process.exit(1);
}

console.log(`platform=${process.platform} arch=${process.arch}`);
console.log(`compositor packages present: ${present.join(', ') || '(none)'}`);

if (!present.includes(want)) {
  console.error(
    `MISSING ${want}. Optional dependencies were skipped — install with --include=optional.`,
  );
  process.exit(1);
}

console.log(`OK ${want} present`);
