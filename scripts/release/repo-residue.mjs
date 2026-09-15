#!/usr/bin/env node
/**
 * SKR-042 — repository residue guard.
 *
 * Defect: the repo had accumulated residue that nothing surfaced — 189 unreachable
 * commits, a populated `.git/lost-found/` (1.5 MB, 370 entries), and 29 committed
 * `state/backup-*` control snapshots. None of it was load-bearing, and all of it would
 * have kept growing unnoticed.
 *
 * This guard makes the accumulation visible. It is deliberately a THRESHOLD check rather
 * than a zero check: ordinary work legitimately creates a few unreachable objects, so a
 * hard zero would fail on healthy repos and get muted. A muted guard is worse than none.
 *
 * Checks
 *   1. unreachable commits        — fails above a budget (default 25)
 *   2. .git/lost-found            — fails if present and populated
 *   3. committed state/backup-*   — fails on any tracked redundancy snapshot
 *
 * Usage:
 *   node scripts/release/repo-residue.mjs [--max-unreachable N] [--json]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const maxArg = args.indexOf('--max-unreachable');
const MAX_UNREACHABLE = maxArg >= 0 ? Number(args[maxArg + 1]) : 25;

const git = (a) =>
  execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

/**
 * Is git actually usable here?
 *
 * `git fsck` exiting non-zero is normal (it reports problems that way), so the call above
 * cannot distinguish "found nothing" from "never ran". Without this probe a missing git —
 * an empty PATH, a PATH-less cron, a container without git — produced EMPTY output that read
 * as "zero unreachable commits", and the guard printed "within budget on every check" and
 * exited 0. A guard that reports all-clear when it could not look is the exact false green
 * this script exists to prevent.
 */
export function gitUsable(repoRoot = REPO) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function unreachableCommits(repoRoot = REPO) {
  if (!gitUsable(repoRoot)) {
    throw new Error('git is unavailable — cannot inspect unreachable objects');
  }
  let out = '';
  try {
    out = execFileSync('git', ['fsck', '--unreachable', '--no-progress'], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // `git fsck` exits non-zero when it finds problems, but still prints the list.
    out = (err && err.stdout) || '';
  }
  return out.split('\n').filter((l) => l.includes('unreachable commit')).map((l) => l.trim().split(/\s+/).pop());
}

export function lostFoundEntries(repoRoot = REPO) {
  const dir = path.join(repoRoot, '.git', 'lost-found');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub);
    if (fs.statSync(p).isDirectory()) n += fs.readdirSync(p).length;
  }
  return n;
}

export function trackedBackupSnapshots(repoRoot = REPO) {
  if (!gitUsable(repoRoot)) {
    throw new Error('git is unavailable — cannot list tracked files');
  }
  try {
    return execFileSync('git', ['ls-files', 'state/backup-*'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function scanResidue(repoRoot = REPO, maxUnreachable = MAX_UNREACHABLE) {
  const unreachable = unreachableCommits(repoRoot);
  const lostFound = lostFoundEntries(repoRoot);
  const backups = trackedBackupSnapshots(repoRoot);

  const findings = [];
  if (unreachable.length > maxUnreachable) {
    findings.push({
      check: 'unreachable-commits',
      detail: `${unreachable.length} unreachable commit(s) (budget ${maxUnreachable})`,
      hint: 'git reflog expire --expire=now --all && git gc --prune=now',
    });
  }
  if (lostFound > 0) {
    findings.push({
      check: 'lost-found',
      detail: `.git/lost-found holds ${lostFound} entr${lostFound === 1 ? 'y' : 'ies'}`,
      hint: 'rm -rf .git/lost-found (regenerable with git fsck --lost-found)',
    });
  }
  if (backups.length > 0) {
    findings.push({
      check: 'tracked-backup-snapshots',
      detail: `${backups.length} tracked state/backup-* snapshot(s)`,
      hint: 'git rm --cached <paths> — git history already stores every prior version of these files',
    });
  }

  return { counts: { unreachable: unreachable.length, lostFound, backups: backups.length }, findings, maxUnreachable };
}

function main() {
  let scan;
  try {
    scan = scanResidue();
  } catch (err) {
    console.error(`repo-residue: cannot verify — ${err.message}`);
    console.error('repo-residue: failing closed rather than reporting an unverified all-clear');
    process.exit(1);
  }
  const { counts, findings, maxUnreachable: budget } = scan;

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ counts, budget, findings }, null, 2) + '\n');
  } else {
    console.log(
      `repo-residue: ${counts.unreachable} unreachable commit(s) (budget ${budget}), ` +
        `${counts.lostFound} lost-found entr${counts.lostFound === 1 ? 'y' : 'ies'}, ` +
        `${counts.backups} tracked backup snapshot(s)`,
    );
    if (findings.length) {
      console.error(`repo-residue: ${findings.length} residue check(s) failing:`);
      for (const f of findings) {
        console.error(`  - [${f.check}] ${f.detail}`);
        console.error(`      fix: ${f.hint}`);
      }
    } else {
      console.log('repo-residue: within budget on every check');
    }
  }

  process.exit(findings.length ? 1 : 0);
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
