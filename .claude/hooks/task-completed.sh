#!/usr/bin/env bash
# TaskCompleted hook (REC-006) — block premature closes with exit 2.
# Registered in .claude/settings.json as the TaskCompleted command hook.
# Thin executable entry: pipes stdin through to the TypeScript implementation
# (scripts/hooks/task-completed.ts) and exits with its code — 0 when the
# acceptance/QC evidence trail is complete, 2 (blocking feedback naming
# exactly what remains) when it is not.
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

exec $TSX "$REPO_ROOT/scripts/hooks/task-completed.ts" "$@"
