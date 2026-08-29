#!/usr/bin/env bash
# SessionEnd hook (REC-005) — final checkpoint + exact resume state.
# Registered in .claude/settings.json as the SessionEnd command hook.
# Thin executable entry: pipes stdin through to the TypeScript implementation
# (scripts/hooks/session-end.ts) and exits with its code — 0 after the flush,
# 2 with stderr detail when the final flush failed (SessionEnd cannot block
# the session from ending, but the failure is surfaced loudly for recovery).
set -uo pipefail

# Resolve the repo root from this script's own location: the hook is executed
# by Claude Code from the project root, but resolve from the file itself so a
# different cwd still finds the engine.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export MMCS_REPO_ROOT="$REPO_ROOT"

# Prefer repo-local tsx, fall back to npx resolution.
TSX="$(command -v tsx || true)"
if [ -z "$TSX" ] && [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
fi
if [ -z "$TSX" ]; then
  TSX="npx tsx"
fi

exec $TSX "$REPO_ROOT/scripts/hooks/session-end.ts" "$@"
