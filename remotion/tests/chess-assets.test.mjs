// PF-1 regression test: the chess piece SVG set must exist and match the codes
// remotion/src/lib/chess.tsx renders via staticFile('library/chess/<code>.svg').
// Upstream shipped without this directory (BASELINE-REPORT.md PF-1) — Short1Chess
// crashed with EncodingError on every render. If an SVG goes missing or becomes
// invalid XML, every chess composition fails at render time again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..');
const chessDir = path.join(repoRoot, 'media', 'library', 'chess');
const chessTsx = readFileSync(path.join(root, 'src', 'lib', 'chess.tsx'), 'utf8');

// The Piece type in chess.tsx is the single source of truth for which sprites render.
const pieceCodes = (() => {
  const m = chessTsx.match(/export type Piece = ([^;]+);/);
  assert.ok(m, 'chess.tsx must declare `export type Piece = ...`');
  return [...m[1].matchAll(/'([wb][KQRBNP])'/g)].map((x) => x[1]);
})();

test('chess.tsx declares the 12 standard piece codes', () => {
  assert.equal(pieceCodes.length, 12);
  assert.deepEqual(
    [...pieceCodes].sort(),
    ['bB', 'bK', 'bN', 'bP', 'bQ', 'bR', 'wB', 'wK', 'wN', 'wP', 'wQ', 'wR'],
  );
});

test('every declared piece has an SVG in media/library/chess/', () => {
  const present = new Set(readdirSync(chessDir));
  for (const code of pieceCodes) {
    assert.ok(present.has(`${code}.svg`), `missing media/library/chess/${code}.svg`);
  }
});

test('every chess SVG parses as valid XML with an <svg> root', () => {
  for (const code of pieceCodes) {
    const file = path.join(chessDir, `${code}.svg`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /<svg[\s>]/, `${code}.svg has no <svg> root element`);
    // Cheap structural sanity: balanced angle brackets, non-empty.
    assert.ok(text.includes('</svg>'), `${code}.svg is truncated`);
    assert.ok(text.length > 100, `${code}.svg is suspiciously small`);
  }
});

test('chess.tsx still references the library path (kit contract intact)', () => {
  assert.match(
    chessTsx,
    /staticFile\(`library\/chess\/\$\{sp\.code\}\.svg`\)/,
    'chess.tsx no longer loads pieces from library/chess — update this test or the kit',
  );
});