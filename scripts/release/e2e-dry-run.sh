#!/usr/bin/env bash
# e2e-dry-run.sh — REL-004: one command end-to-end dry run of the MMCS §30
# pipeline (scenarios S0–S23 in scripts/release/e2e-dry-run.ts).
#
#   bash scripts/release/e2e-dry-run.sh [--markdown] [--keep] [--scratch DIR]
#
# The runner executes the whole §30 stage list against REAL subsystem code
# with zero provider spend and zero live credentials: a controlled short
# sample project is driven from intake → concept → script → planning →
# storyboards → character lock → budget gate → (mocked paid generation where
# credentials are absent) → restart/resume → GHL archival → rough cut →
# final render (REAL ffmpeg + ffprobe) → canon → checkpoint resume; every
# scenario must pass or the script exits non-zero.
#
# Options:
#   --markdown       also write docs/e2e-dry-run-report.md from the same run
#                    (the committed report is the script's own output)
#   --keep           keep the scratch run dir (default: removed on exit)
#   --scratch DIR    use an explicit scratch root instead of a mktemp
#   --help | -h      print this help
#
# Exit codes: 0 all scenarios PASS · 1 any scenario FAIL / crash · 2 usage.
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
    --keep) EXTRA+=("--keep") ;;
    --scratch) shift; [ $# -gt 0 ] || { echo "ERROR: --scratch needs a value" >&2; exit 2; }; EXTRA+=("--scratch" "$1") ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$REPO_ROOT" || exit 1
exec npx --yes tsx "${TSX_ARGS[@]}" scripts/release/e2e-dry-run.ts "${EXTRA[@]}"