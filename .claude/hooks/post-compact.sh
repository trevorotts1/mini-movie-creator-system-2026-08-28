#!/bin/sh
# PostCompact hook wrapper (REC-003) — spec.md §28 / runbook §6.
#
# Claude Code invokes this file after a context compaction. It delegates to
# scripts/hooks/post-compact.ts (the owned implementation, run through tsx),
# which:
#   1. reads the hook JSON payload from stdin,
#   2. records the spec §28 "post-compact" cadence event through the REC-001
#      checkpoint wiring (cross-process lock, atomic write),
#   3. updates the state/recovery.json recovery marker,
#   4. prints the disk-truth read order so the resumed session re-reads the
#      project state from disk — the compaction summary is CONTEXT ONLY,
#      never the sole project state.
#
# The hook must never block a compaction: unexpected failures exit 0 with a
# note on stderr; only a failed durable checkpoint write exits 1 so the
# failure surfaces. Set MMCS_REPO_ROOT to target a different repo root
# (defaults to the MMCS checkout that contains this script).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# The MMCS checkout this hook belongs to (script resolution — always the
# directory containing .claude/hooks/).
MMCS_HOME=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
# The repo root whose state/ is written (defaults to MMCS_HOME).
REPO_ROOT=${MMCS_REPO_ROOT:-$MMCS_HOME}

TSX="$MMCS_HOME/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  # Fall back to the npx cache used by the REC-001 wiring (node 26
  # strip-types does not resolve .js specifiers; tsx is the sanctioned
  # runner on this box).
  for d in "$HOME"/.npm/_npx/*/node_modules/.bin; do
    if [ -x "$d/tsx" ]; then
      TSX="$d/tsx"
      break
    fi
  done
fi

if [ ! -x "$TSX" ]; then
  echo "post-compact.sh: tsx runner not found (expected $MMCS_HOME/node_modules/.bin/tsx or npx cache)" >&2
  exit 0
fi

if [ ! -f "$MMCS_HOME/scripts/hooks/post-compact.ts" ]; then
  echo "post-compact.sh: $MMCS_HOME/scripts/hooks/post-compact.ts missing" >&2
  exit 0
fi

exec "$TSX" "$MMCS_HOME/scripts/hooks/post-compact.ts" --repo-root "$REPO_ROOT"
