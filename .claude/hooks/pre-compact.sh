#!/usr/bin/env bash
# PreCompact hook (REC-002) — save-first, compact-second.
# Registered in .claude/settings.json as the PreCompact command hook.
# Thin executable entry: pipes stdin through to the TypeScript implementation
# (scripts/hooks/pre-compact.ts) and exits with its code — 0 after the flush,
# 2 when the flush failed so compaction does not proceed over a lost save.
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

exec $TSX "$REPO_ROOT/scripts/hooks/pre-compact.ts" "$@"
