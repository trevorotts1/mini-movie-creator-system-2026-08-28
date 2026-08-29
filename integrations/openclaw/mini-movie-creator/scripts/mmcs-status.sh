#!/usr/bin/env bash
# mmcs-status.sh — OpenClaw skill convenience wrapper (SKL-005).
#
# Resolves the MMCS engine root the same way SKILL.md §0 teaches, then runs
# `mmcs status`. Never guesses a path: explicit --mmcs-root flag overrides,
# then MMCS_ROOT env (SKILL.md §0), then walk up from cwd for a checkout whose
# package.json name is "mmcs-monorepo". If nothing resolves, exits 2 with
# instructions (never invents a path).
#
# Usage:
#   mmcs-status.sh                 # status via resolved engine
#   mmcs-status.sh --mmcs-root D   # explicit engine root
#   mmcs-status.sh --check         # 0 = engine resolvable and runnable
#
# Exit codes: 0 ok · 1 mmcs status failed · 2 engine not resolvable.

set -u

MMCS_PACKAGE_NAME="mmcs-monorepo"
# SKILL.md §0 resolution order: MMCS_ROOT env → --mmcs-root flag → cwd walk.
# Inherit the env var here; the flag overrides it below.
MMCS_ROOT="${MMCS_ROOT:-}"
MMCS_BIN=""
MODE="status"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mmcs-root)
      [ "$#" -ge 2 ] || { echo "mmcs-status.sh: --mmcs-root needs a value" >&2; exit 2; }
      MMCS_ROOT="$2"; shift 2 ;;
    --mmcs-root=*)
      MMCS_ROOT="${1#*=}"; shift ;;
    --check)
      MODE="check"; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "mmcs-status.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- resolve engine root (never guess) --------------------------------------
resolve_root_from() {
  # Walk upward from $1 looking for a package.json named mmcs-monorepo.
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${MMCS_PACKAGE_NAME}\"" "$dir/package.json" 2>/dev/null; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

if [ -z "$MMCS_ROOT" ]; then
  MMCS_ROOT="$(resolve_root_from "$PWD" || true)"
fi

# Persistent-location fallback (survives container recreates): the engine is
# installed at the client workspace's persisted mmcs/ dir by install-client.sh.
if [ -z "$MMCS_ROOT" ]; then
  for c in "$HOME/.openclaw/workspace/mmcs" "$HOME/.openclaw/workspace/mmcs"; do
    if [ -n "$c" ] && [ -f "$c/package.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${MMCS_PACKAGE_NAME}\"" "$c/package.json" 2>/dev/null; then
      MMCS_ROOT="$c"; break
    fi
  done
fi

if [ -z "$MMCS_ROOT" ]; then
  echo "mmcs-status.sh: MMCS engine root not resolvable." >&2
  echo "Set MMCS_ROOT to the mmcs-monorepo checkout, run from inside it," >&2
  echo "or pass --mmcs-root <path>. Never guessed." >&2
  exit 2
fi

if [ ! -f "$MMCS_ROOT/package.json" ]; then
  echo "mmcs-status.sh: '$MMCS_ROOT' has no package.json — not an engine root." >&2
  exit 2
fi

# --- resolve the runner (PATH mmcs → built CLI → node src) -------------------
run_mmcs() {
  if [ -n "$MMCS_BIN" ]; then
    "$MMCS_BIN" "$@"
    return $?
  fi
  if command -v mmcs >/dev/null 2>&1; then
    mmcs "$@"
    return $?
  fi
  if [ -f "$MMCS_ROOT/apps/cli/dist/index.js" ]; then
    node "$MMCS_ROOT/apps/cli/dist/index.js" "$@"
    return $?
  fi
  echo "mmcs-status.sh: no runner found." >&2
  echo "Build it once: (cd '$MMCS_ROOT/apps/cli' && npm run build)" >&2
  return 127
}

if [ "$MODE" = "check" ]; then
  run_mmcs status >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "mmcs-status.sh: OK — engine at $MMCS_ROOT responds to 'mmcs status'."
  fi
  exit "$rc"
fi

run_mmcs status
exit $?