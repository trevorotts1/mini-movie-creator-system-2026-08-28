#!/bin/sh
# SessionStart hook (REC-004) — inject recovery context into a new/resumed
# session (spec.md §28 / runbook §6). Registered in .claude/settings.json as
# the SessionStart command hook.
#
# Thin executable entry: pipes stdin through to the TypeScript implementation
# (scripts/hooks/session-start.ts, run through tsx), which:
#   1. reads the untrusted hook JSON payload from stdin (tolerant),
#   2. emits ONE <session-start-context> block on stdout — the recovery
#      injection Claude Code adds to the session: orchestrator-only reminder,
#      recovery read-order pointers (recovery.md, checkpoint.json, todo.md,
#      sized ledger/session tails), live worktree reconcile vs records,
#      duplicate prevention (never re-dispatch ACTIVE/PASS/MERGED), and the
#      two /loop skills verified or recreated,
#   3. appends one SESSION_START_RECOVERY line to ledger.md.
#
# The hook must never block a session start: unexpected failures exit 0 with
# a minimal fallback context block on stdout and a note on stderr. Only a
# CLI misuse (unknown flag / missing flag value) exits 2 so the
# misconfiguration is loud.
set -u

# The MMCS checkout this hook belongs to (engine + tsx resolution — always the
# directory containing .claude/hooks/). MMCS_REPO_ROOT, when the caller set it
# (tests target a simulated repo root), only changes which state/ is read and
# where ledger.md is written — never where the engine itself loads from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MMCS_HOME=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
REPO_ROOT=${MMCS_REPO_ROOT:-$MMCS_HOME}
export MMCS_REPO_ROOT="$REPO_ROOT"

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
  echo "session-start.sh: tsx runner not found (expected $MMCS_HOME/node_modules/.bin/tsx or npx cache)" >&2
  # Degraded but non-blocking: the minimal recovery block still reaches the
  # session so it is never left without recovery context.
  cat <<'EOF'
<session-start-context>
MMCS recovery context UNAVAILABLE (session-start hook could not run). Run recovery.md by hand before acting:
read recovery.md, state/checkpoint.json, build-status.md, todo.md, ledger tail (200 lines), session.md tail.
Lead session is ORCHESTRATOR ONLY. Never duplicate ACTIVE/PASS/MERGED tasks.
</session-start-context>
EOF
  exit 0
fi

if [ ! -f "$MMCS_HOME/scripts/hooks/session-start.ts" ]; then
  echo "session-start.sh: $MMCS_HOME/scripts/hooks/session-start.ts missing" >&2
  exit 0
fi

exec "$TSX" "$MMCS_HOME/scripts/hooks/session-start.ts" --repo-root "$REPO_ROOT"

