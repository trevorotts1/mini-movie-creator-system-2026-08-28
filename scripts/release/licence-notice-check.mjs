#!/usr/bin/env node
/**
 * Keeps THIRD-PARTY-NOTICES.md honest (SKR-045).
 *
 * The notices file makes checkable claims about the FFmpeg build bundled in the Remotion
 * compositor: that `--enable-gpl` is present, that `--enable-nonfree` is ABSENT, and that
 * the binary reports GPL. Those claims are a property of the PINNED binary and silently
 * become false when the Remotion version is bumped. Prose that used to be true is worse
 * than no prose, so this fails when the file and the binary disagree.
 *
 * Skips (loudly) when the platform compositor is not installed — it cannot verify what is
 * not there, and a quiet pass would be a false green.
 *
 * Usage: node scripts/release/licence-notice-check.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const NOTICES = path.join(REPO, 'THIRD-PARTY-NOTICES.md');
const JSON_OUT = new Set(process.argv.slice(2)).has('--json');

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
const compDir = path.join(REPO, 'remotion', 'node_modules', `@remotion`, `compositor-${platform}-${arch}`);

function main() {
  const findings = [];

  if (!fs.existsSync(NOTICES)) {
    findings.push({ check: 'notices-exist', detail: 'THIRD-PARTY-NOTICES.md is missing' });
  } else {
    const text = fs.readFileSync(NOTICES, 'utf8');
    // The file must not re-assert the disproven claim.
    // Match the claim however it is phrased: the flag, then "is", then "present", within a
    // short window. An earlier, tighter regex silently failed to fire on the real wording —
    // caught by the reverse-mutation test, which is why that test exists.
    const assertsNonfree = /--enable-nonfree[^\n]{0,60}?is\s+\*{0,2}present/i.test(text);
    const assertsOldWording = /built\s+`?--enable-gpl --enable-nonfree`?/.test(text);
    if (assertsNonfree || assertsOldWording) {
      findings.push({
        check: 'notices-claim',
        detail: 'THIRD-PARTY-NOTICES.md asserts --enable-nonfree is present; the pinned binary refutes that',
      });
    }
  }

  const bin = path.join(compDir, 'ffmpeg');
  if (!fs.existsSync(bin)) {
    const note = `compositor-${platform}-${arch} not installed — cannot verify the FFmpeg claims on this platform`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ verified: false, note, findings }, null, 2) + '\n');
    else console.log(`licence-notice: SKIPPED — ${note}`);
    process.exit(findings.length ? 1 : 0);
  }

  let version = '';
  try {
    // The bundled ffmpeg will not run by bare path: its dylibs use relative install names.
    version = execFileSync('./ffmpeg', ['-version'], {
      cwd: compDir,
      encoding: 'utf8',
      env: { ...process.env, DYLD_LIBRARY_PATH: compDir, LD_LIBRARY_PATH: compDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    findings.push({ check: 'ffmpeg-run', detail: `could not run the bundled ffmpeg: ${err.message.split('\n')[0]}` });
  }

  if (version) {
    const isGpl = version.includes('--enable-gpl');
    const isNonfree = version.includes('--enable-nonfree');
    if (!isGpl) findings.push({ check: 'gpl-flag', detail: 'the bundled ffmpeg no longer shows --enable-gpl' });
    if (isNonfree) {
      findings.push({
        check: 'nonfree-flag',
        detail: 'the bundled ffmpeg now shows --enable-nonfree — it is NOT redistributable; THIRD-PARTY-NOTICES.md must be rewritten',
      });
    }
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({ verified: true, isGpl, isNonfree, findings }, null, 2) + '\n');
    } else {
      console.log(`licence-notice: verified against compositor-${platform}-${arch} — --enable-gpl ${isGpl ? 'present' : 'ABSENT'}, --enable-nonfree ${isNonfree ? 'PRESENT' : 'absent'}`);
      for (const f of findings) console.error(`  - [${f.check}] ${f.detail}`);
    }
  } else if (!JSON_OUT) {
    for (const f of findings) console.error(`  - [${f.check}] ${f.detail}`);
  }

  process.exit(findings.length ? 1 : 0);
}

main();
