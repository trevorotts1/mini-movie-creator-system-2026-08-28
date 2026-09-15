#!/usr/bin/env node
/**
 * SKR-036 — make `MERGED` a derivation, not an assertion.
 *
 * `state/tasks.json` historically recorded a bare `"status": "MERGED"` per task with
 * no evidence field, 46 branch names that no longer resolve, and at least one entry
 * (CAP-009) whose own note records a rollback while its status still read MERGED.
 * "MERGED" was therefore unfalsifiable: nothing in the repo could confirm or refute it.
 *
 * This script derives merge evidence from git and fails closed when a task claims
 * MERGED but nothing in the repository supports the claim. It does not trust the
 * ledger — it re-derives from the commit graph and the working tree on every run.
 *
 * Derivation rules
 *   1. A task's merge commit is the merge commit reachable from HEAD whose subject
 *      contains the task id as a bounded token (`REC-011 ` matches, `REC-0110` does not).
 *      Subjects are the repo's actual convention: `merge: REC-011 auto-compact simulation (...)`.
 *   2. A task's owned paths are `ownsNow` when present (the path the work actually landed
 *      at, after a rename), otherwise `owns` (the path as declared when the task was cut).
 *      `owns` is never rewritten — it is the historical record.
 *   3. Claimed MERGED + no merge commit            -> UNSUBSTANTIATED_NO_MERGE
 *      Claimed MERGED + no resolvable owned path   -> UNSUBSTANTIATED_NO_PATHS
 *      Claimed MERGED + merge commit + 0 paths present -> UNSUBSTANTIATED_PATHS_ABSENT
 *      otherwise                                   -> SUBSTANTIATED
 *
 * Usage:
 *   node scripts/release/task-ledger-verify.mjs            # verify; exit 1 on any gap
 *   node scripts/release/task-ledger-verify.mjs --write    # rewrite derived fields, then verify
 *   node scripts/release/task-ledger-verify.mjs --json     # machine-readable report on stdout
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LEDGER = path.join(REPO, 'state', 'tasks.json');

const argv = new Set(process.argv.slice(2));
const WRITE = argv.has('--write');
const JSON_OUT = argv.has('--json');

const git = (args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }).trimEnd();

// ---------------------------------------------------------------------------
// owned-path resolution
// ---------------------------------------------------------------------------

/**
 * Split on commas/semicolons that are NOT inside parentheses, so a parenthetical file
 * list survives intact: `dir/ (a.md, b.md)` is one segment, not three.
 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Turn an `owns` / `ownsNow` string into repo-relative paths.
 *
 * These strings were written by hand during planning, so they mix real paths with
 * prose, parenthetical file lists, globs and `$HOME` references. Anything that is not
 * a repo-relative path is reported as `outOfRepo` rather than silently dropped, so an
 * unparseable `owns` can never be mistaken for a passing check.
 */
export function resolveOwnedPaths(raw) {
  const inRepo = [];
  const outOfRepo = [];
  const text = String(raw ?? '').trim();
  if (!text) return { inRepo, outOfRepo };

  // `dir/ (a.md, b.md)` -> the files inside `dir/`.
  const parenthetical = /\s*\(([^)]*)\)\s*$/;
  const segments = splitTopLevel(text);

  const push = (token) => {
    let p = token.replace(/[`"']/g, '').trim();
    if (!p) return;
    if (p.startsWith('$HOME') || p.startsWith('~')) return outOfRepo.push(token.trim());
    // Prose such as "state/ writers" or "BASELINE-REPORT.md (append audit section)".
    p = p.replace(parenthetical, '').trim();
    if (!p) return;
    if (/\s/.test(p)) {
      const head = p.split(/\s+/)[0];
      // "state/ writers" -> "state/"; "packages/x/ (see notes)" already handled above.
      p = head.endsWith('/') ? head : p.split(/\s+/).find((w) => w.includes('/')) ?? head;
    }
    if (p.includes('*')) {
      const dir = path.posix.dirname(p);
      const base = path.posix.basename(p);
      let names = [];
      try {
        names = fs.readdirSync(path.join(REPO, dir));
      } catch {
        names = [];
      }
      const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const hits = names.filter((n) => re.test(n)).map((n) => path.posix.join(dir, n));
      if (hits.length) hits.forEach((h) => inRepo.push(h));
      else inRepo.push(p);
      return;
    }
    inRepo.push(p.replace(/\/+$/, ''));
  };

  for (const seg of segments) {
    const m = seg.match(parenthetical);
    const parent = seg.replace(parenthetical, '').trim();
    push(seg);
    // `skills/x/ (SKILL.md, references/a.md)` -> the listed files live under `skills/x/`.
    if (m && parent.endsWith('/')) {
      for (const item of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!item.includes('/') && !/\.\w+$/.test(item)) continue;
        if (item.startsWith(parent)) push(item);
        else push(parent + item);
      }
    }
  }

  return { inRepo: [...new Set(inRepo)], outOfRepo };
}

// ---------------------------------------------------------------------------
// merge-commit attribution
// ---------------------------------------------------------------------------

/** Merge commits reachable from HEAD, newest first. */
export function mergeIndex() {
  const raw = git(['log', '--merges', '--format=%H%x1f%cI%x1f%s', 'HEAD']);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, date, subject] = line.split('\x1f');
      return { commit, date, subject };
    });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The task id as a bounded token, so `REC-011` never matches inside `REC-0110`. */
export function idMatcher(id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(id)}([^0-9]|$)`);
}

function existsInTree(rel) {
  const abs = path.join(REPO, rel);
  try {
    fs.statSync(abs);
    return true;
  } catch {
    return false;
  }
}

function branchState(branch) {
  if (!branch) return 'none-declared';
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return 'present';
  } catch {
    /* fall through */
  }
  try {
    git(['rev-parse', '--verify', '--quiet', branch]);
    return 'present';
  } catch {
    return 'absent';
  }
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

export function verifyLedger(ledger) {
  const merges = mergeIndex();
  const items = Array.isArray(ledger.items) ? ledger.items : [];
  const results = [];

  for (const item of items) {
    const { inRepo, outOfRepo } = resolveOwnedPaths(item.ownsNow ?? item.owns);
    const present = inRepo.filter(existsInTree);
    const absent = inRepo.filter((p) => !existsInTree(p));
    const re = idMatcher(String(item.id));
    const match = merges.find((m) => re.test(m.subject)) ?? null;

    const status = String(item.status ?? '').toUpperCase();
    const claimsMerged = status === 'MERGED';

    // A recorded sha that disagrees with the commit graph is a hard failure, never
    // something to quietly overwrite: the recorded value is the claim under test.
    const recordedSha = item.mergedSha ?? null;
    const shaMismatch = Boolean(recordedSha && match && recordedSha !== match.commit);
    const shaDangling = Boolean(recordedSha && !match);

    let verdict;
    if (!claimsMerged) verdict = 'NOT-CLAIMED-MERGED';
    else if (shaMismatch || shaDangling) verdict = 'EVIDENCE_MISMATCH';
    else if (!match) verdict = 'UNSUBSTANTIATED_NO_MERGE';
    else if (!inRepo.length) verdict = 'UNSUBSTANTIATED_NO_PATHS';
    else if (!present.length) verdict = 'UNSUBSTANTIATED_PATHS_ABSENT';
    else verdict = 'SUBSTANTIATED';

    results.push({
      id: item.id,
      title: item.title,
      status: item.status,
      verdict,
      recordedSha,
      shaMismatch,
      merge: match,
      branch: item.branch ?? null,
      branchState: branchState(item.branch),
      ownedPaths: inRepo,
      present,
      absent,
      outOfRepo,
    });
  }

  const failing = results.filter(
    (r) => r.verdict.startsWith('UNSUBSTANTIATED') || r.verdict === 'EVIDENCE_MISMATCH',
  );
  return {
    checkedAt: new Date().toISOString(),
    head: git(['rev-parse', 'HEAD']),
    total: results.length,
    substantiated: results.filter((r) => r.verdict === 'SUBSTANTIATED').length,
    failing,
    results,
  };
}

// ---------------------------------------------------------------------------
// ledger rewriting
// ---------------------------------------------------------------------------

/** Preserve the file's existing indentation so the diff is evidence, not reformatting. */
function detectIndent(text) {
  const m = text.match(/\n(\s+)"/);
  return m ? m[1] : ' ';
}

function applyEvidence(ledger, report) {
  const byId = new Map(report.results.map((r) => [r.id, r]));
  const next = { ...ledger };
  next.items = (ledger.items ?? []).map((item) => {
    const r = byId.get(item.id);
    if (!r) return item;
    const out = { ...item };
    if (r.merge) {
      out.merge = { commit: r.merge.commit, date: r.merge.date, subject: r.merge.subject };
      // Backfill the historical pair only when absent. A present-but-wrong sha is a
      // reported failure (EVIDENCE_MISMATCH) and must be corrected by a human.
      if (!out.mergedSha) out.mergedSha = r.merge.commit;
      if (!out.mergedAt) out.mergedAt = r.merge.date;
    } else {
      delete out.merge;
    }
    out.branchState = r.branchState;
    return out;
  });
  return next;
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(LEDGER)) {
    console.error(`task-ledger-verify: ${path.relative(REPO, LEDGER)} not found`);
    process.exit(1);
  }
  const raw = fs.readFileSync(LEDGER, 'utf8');
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    console.error(`task-ledger-verify: ${path.relative(REPO, LEDGER)} is not valid JSON — ${err.message}`);
    process.exit(1);
  }

  let report = verifyLedger(ledger);

  if (WRITE) {
    const next = applyEvidence(ledger, report);
    // Bump `updated_at` only when the derived evidence actually changed, so a no-op
    // verification is a no-op diff instead of daily churn.
    const changed = JSON.stringify(next.items) !== JSON.stringify(ledger.items);
    if (changed) next.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(LEDGER, JSON.stringify(next, null, detectIndent(raw)) + '\n');
    report = verifyLedger(next);
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      checkedAt: report.checkedAt,
      head: report.head,
      total: report.total,
      substantiated: report.substantiated,
      failing: report.failing.map((f) => ({
        id: f.id, verdict: f.verdict, absent: f.absent, ownedPaths: f.ownedPaths,
      })),
    }, null, 2) + '\n');
  } else {
    const pruned = report.results.filter((r) => r.branchState === 'absent').length;
    console.log(
      `task-ledger: ${report.substantiated}/${report.total} MERGED task(s) substantiated by merge commit + present owned path`,
    );
    console.log(`task-ledger: ${pruned} declared branch(es) pruned after merge (recorded, not claimed live)`);
    if (report.failing.length) {
      console.error(`task-ledger: ${report.failing.length} MERGED task(s) UNSUBSTANTIATED:`);
      for (const f of report.failing) {
        console.error(`  - ${f.id} [${f.verdict}] ${f.title ?? ''}`);
        if (f.absent.length) console.error(`      absent: ${f.absent.join(', ')}`);
        if (!f.ownedPaths.length) console.error(`      no repo-relative owned path in: ${JSON.stringify(f.outOfRepo)}`);
      }
    }
  }

  process.exit(report.failing.length ? 1 : 0);
}

// Compare REAL paths, not lexical ones: on macOS os.tmpdir() hands back /var/... which is
// a symlink to /private/var/..., and node resolves the module URL to the real path. A
// lexical compare silently skips main() there — the script would print nothing and exit 0,
// which is precisely the false-green this whole check exists to prevent.
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
