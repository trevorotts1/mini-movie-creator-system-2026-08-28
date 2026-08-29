#!/usr/bin/env bash
# TeammateIdle hook (REC-007) — block idle while the teammate owns work.
# Registered in .claude/settings.json as the TeammateIdle command hook.
# Thin executable entry: pipes stdin through to the TypeScript implementation
# (scripts/hooks/teammate-idle.ts) and exits with its code — 0 when idle is
# allowed, 2 when the idle is blocked and stderr carries the continue
# instruction (finish owned ACTIVE/QC_FIXING work, or claim the next
# compatible READY task in the same workflow).
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

exec $TSX "$REPO_ROOT/scripts/hooks/teammate-idle.ts" "$@"
