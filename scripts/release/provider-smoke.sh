#!/usr/bin/env bash
# provider-smoke.sh — REL-005: minimal provider smoke (spec §30).
#
#   bash scripts/release/provider-smoke.sh [--markdown] [--live] [--help]
#
# Default (report-only): a ZERO-SPEND credential-gating pass — for each
# provider (agnes/kie/fish/ghl) it prints CREDENTIALED or MOCKED/BLOCKED by
# env-var presence only, enforces the §4 $25 spend-gate arithmetic
# (projection is always $0 in report-only mode), and exits 0.
#
# Options:
#   --markdown       also write docs/provider-smoke-report.md from this run
#                    (the committed report is the script's own output)
#   --live           live-gated mode: requires BOTH MMCS_SMOKE_LIVE=1 AND a
#                    non-empty MMCS_SMOKE_COST_ACK (explicit spend consent);
#                    without either, providers stay MOCKED/BLOCKED. NOT used
#                    in the build — every absent credential is mocked + BLOCKED.
#   --help | -h      print this help
#
# Exit codes: 0 smoke PASS · 1 smoke FAIL · 2 usage.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_usage() {
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | grep -E '^#( |$)' | sed 's/^# \{0,1\}//'
  exit 2
}

TSX_ARGS=(--tsconfig "$SCRIPT_DIR/tsconfig.json")
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --markdown) EXTRA+=("--markdown") ;;
    --live) EXTRA+=("--live") ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$REPO_ROOT" || exit 1
exec npx --yes tsx "${TSX_ARGS[@]}" scripts/release/provider-smoke.ts "${EXTRA[@]}"