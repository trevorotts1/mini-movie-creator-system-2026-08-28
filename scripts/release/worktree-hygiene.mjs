#!/usr/bin/env node
/**
 * SKR-041 — worktree hygiene guard.
 *
 * Defect: seven files sat untracked or modified inside task worktrees — four npm
 * `package-lock.json` files in a pnpm repo, two stale one-line QC sha restamps, and a
 * superseded root `vitest.config.mts`. Nothing surfaced them. `git worktree prune`, or
 * simply deleting a finished task's worktree, would have destroyed them without a sound,
 * and a stale QC restamp left sitting in a worktree is worse than losing it: it is
 * unreviewed state that looks like evidence.
 *
 * This guard enumerates every linked worktree and fails when one carries uncommitted
 * state that is not explicitly classified. Silence is the failure mode being fixed, so
 * an unclassified file is a gate failure rather than a warning.
 *
 * Classifications
 *   DISPOSABLE        matches a documented stray pattern (npm lockfile in a pnpm repo,
 *                     editor/OS noise). Safe to delete; reported, never silently ignored.
 *   EVIDENCE          touches a tracked evidence path (state/task-updates/**). Must be
 *                     resolved deliberately, never left to rot in a worktree.
 *   UNCLASSIFIED      anything else, including modified tracked files. Always a failure.
 *
 * Usage:
 *   node scripts/release/worktree-hygiene.mjs           # verify; exit 1 on any finding
 *   node scripts/release/worktree-hygiene.mjs --json    # machine-readable report
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const JSON_OUT = new Set(process.argv.slice(2)).has('--json');

const git = (args, cwd = REPO) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

/**
 * Stray patterns that are safe to discard, each with the reason it is safe. Kept narrow on
 * purpose: a broad pattern would recreate the silence this guard exists to remove.
 */
const DISPOSABLE = [
  {
    // The workspace is pnpm-only (pnpm-workspace.yaml, pnpm-lock.yaml). An npm lockfile
    // in a worktree root is an accidental `npm install`, not a dependency record.
    test: (p) => /^package-lock\.json$/.test(p),
    reason: 'npm lockfile in a pnpm workspace — accidental npm install, not a dependency record',
  },
  {
    test: (p) => /\.(bak|orig|rej)$/.test(p) || /\.bak-\d{8}/.test(p) || p.endsWith('~'),
    reason: 'editor/backup noise; the original is in git history',
  },
  {
    test: (p) => p === '.DS_Store' || p.startsWith('.DS_Store'),
    reason: 'macOS Finder metadata',
  },
];

/**
 * Canonical absolute path. `git worktree list` reports real paths, while a caller's
 * repoRoot may be a symlinked one (macOS hands out /var/... for /private/var/...), so a
 * lexical compare would misclassify the primary checkout as a linked worktree.
 */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function classifyEntry(entry) {
  const status = entry.slice(0, 2);
  // Porcelain paths can be quoted when they contain spaces; strip the quotes.
  const file = entry.slice(3).trim().replace(/^"|"$/g, '');
  const modified = status[0] !== '?' && status[0] !== ' ' ? true : status[1] !== '?';
  if (modified) {
    return {
      file,
      status,
      kind: 'MODIFIED',
      verdict: file.startsWith('state/task-updates/') ? 'EVIDENCE' : 'UNCLASSIFIED',
      reason: file.startsWith('state/task-updates/')
        ? 'uncommitted change to a tracked QC evidence record'
        : 'uncommitted change to a tracked file',
    };
  }
  for (const rule of DISPOSABLE) {
    if (rule.test(file)) return { file, status, kind: 'UNTRACKED', verdict: 'DISPOSABLE', reason: rule.reason };
  }
  if (file.startsWith('state/task-updates/')) {
    return { file, status, kind: 'UNTRACKED', verdict: 'EVIDENCE', reason: 'untracked QC evidence record' };
  }
  return { file, status, kind: 'UNTRACKED', verdict: 'UNCLASSIFIED', reason: 'untracked file with no classification' };
}

export function worktreePaths(repoRoot = REPO) {
  const raw = git(['worktree', 'list', '--porcelain'], repoRoot);
  return raw
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

/**
 * The MAIN worktree path, as git reports it.
 *
 * Scoping must not depend on the caller's spelling of the repo root. `fs.realpathSync` does
 * NOT canonicalise character case on APFS, so a repo reached through a symlink whose stored
 * target says `Projects` while git reports `projects` produced two different "real" roots:
 * the primary checkout was misread as external and every project worktree fell out of scope,
 * neutering the guard completely (exit 0 on state that fails when invoked directly). Taking
 * both sides of the comparison from git's own output removes the caller from the equation.
 */
function mainWorktreeOf(repoRoot) {
  const paths = worktreePaths(repoRoot);
  return paths.length ? paths[0] : repoRoot;
}

/** Scan the worktrees of `repoRoot`. Parameterised so tests can use a real sandbox repo. */
export function scanWorktreesIn(repoRoot) {
  const worktrees = [];
  const mainWt = mainWorktreeOf(repoRoot);
  for (const wt of worktreePaths(repoRoot)) {
    if (!fs.existsSync(wt)) continue;
    let porcelain = '';
    try {
      porcelain = git(['status', '--porcelain'], wt);
    } catch {
      worktrees.push({ path: wt, findings: [], unreadable: true });
      continue;
    }
    const findings = porcelain
      .split('\n')
      .filter(Boolean)
      .map(classifyEntry);
    worktrees.push({ path: wt, findings, unreadable: false });
  }
  const actionable = [];
  const outOfScope = [];
  for (const wt of worktrees) {
    // The primary checkout is never pruned, so in-flight work there is normal and not the
    // subject of this guard. Only LINKED worktrees can be destroyed by `worktree prune`.
    if (real(wt.path) === real(mainWt)) continue;
    // Scope to the project's own task worktrees. A worktree a tool created elsewhere (a QC
    // sandbox under $TMPDIR, say) is that tool's scratch space, not project state that a
    // prune of THIS repo would destroy — failing on it would be a false alarm.
    if (!real(wt.path).startsWith(real(path.join(mainWt, 'worktrees')) + path.sep)) {
      if (wt.findings.length) outOfScope.push({ worktree: wt.path, findings: wt.findings.length });
      continue;
    }
    for (const f of wt.findings) {
      if (f.verdict !== 'DISPOSABLE' || f.kind === 'MODIFIED') {
        actionable.push({ worktree: wt.path, ...f });
      }
    }
  }
  return { worktrees, actionable, outOfScope };
}

function main() {
  const { worktrees, actionable, outOfScope } = scanWorktreesIn(REPO);
  const linked = worktrees.filter((w) => real(w.path) !== real(mainWorktreeOf(REPO)));
  const disposable = linked.flatMap((w) =>
    w.findings.filter((f) => f.verdict === 'DISPOSABLE' && f.kind !== 'MODIFIED').map((f) => `${w.path}/${f.file}`),
  );

  if (JSON_OUT) {
    process.stdout.write(
      JSON.stringify(
        {
          worktrees: linked.length,
          outOfScope: outOfScope.length,
          disposable: disposable.length,
          actionable: actionable.map((a) => ({
            worktree: a.worktree, file: a.file, verdict: a.verdict, reason: a.reason,
          })),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.log(`worktree-hygiene: ${linked.length} linked worktree(s) scanned`);
    if (disposable.length) {
      console.log(`worktree-hygiene: ${disposable.length} documented-disposable stray(s) present (safe to delete):`);
      for (const d of disposable) console.log(`  - ${d}`);
    }
    if (outOfScope.length) {
      console.log(
        `worktree-hygiene: ${outOfScope.length} external worktree(s) with scratch state (not project task worktrees — not failed):`,
      );
      for (const o of outOfScope) console.log(`  - ${o.worktree} (${o.findings} entr${o.findings === 1 ? 'y' : 'ies'})`);
    }
    if (actionable.length) {
      console.error(`worktree-hygiene: ${actionable.length} unclassified/unresolved item(s) in worktrees:`);
      for (const a of actionable) {
        console.error(`  - [${a.verdict}] ${a.worktree}/${a.file} — ${a.reason}`);
      }
    } else {
      console.log('worktree-hygiene: no unclassified state in any worktree');
    }
  }

  process.exit(actionable.length ? 1 : 0);
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
