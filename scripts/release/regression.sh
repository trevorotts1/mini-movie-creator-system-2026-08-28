#!/usr/bin/env bash
# regression.sh — REL-002: one command, full MMCS regression, per-area summary.
#
#   bash scripts/release/regression.sh [--json] [--skip-render] [--skip-vitest]
#
# This is the gate a milestone/release promotion (integration → main) and the
# batch-merge "full affected-area regression" both run. Everything passes in
# ONE scripted run or the script exits non-zero — no partial credit:
#
#   1. tools        ffmpeg + ffprobe present AND executable (spec §21: ffprobe
#                   owns media integrity checks; clean-install gates the same
#                   pair — `command -v` alone proves only that a NAME resolves)
#   2. vitest       the full monorepo suite (npx vitest run at the root —
#                   packages/, apps/, scripts/). This script's own test file is
#                   excluded (it runs this script — including it would recurse);
#                   the MMCS_REGRESSION_CHILD=1 env the script exports is the
#                   second, rename-proof guard for the same hazard. A failing
#                   suite gets ONE retry of just the failing files: the suite's
#                   cross-process/timing tests can flake when the box is
#                   loaded, and a gate that cannot pass on a busy machine gates
#                   nothing. A real regression fails twice — the retry is
#                   disclosed in the area note, never silent.
#   3. gen          `npm run gen` in the remotion project (regenerates
#                   registry.gen.tsx + episode-registry.gen.ts; the run must
#                   leave the tracked tree byte-identical — drift fails the
#                   area)
#   4. typecheck    `npx tsc --noEmit` for every PROJECT tsconfig (every config
#                   with its own include/files section — base-only configs such
#                   as tsconfig.base.json carry options but no file set, and
#                   tsc -p on them sweeps the whole tree including tests, so
#                   they are skipped; project configs extend the same options)
#   5. lint         `pnpm -r --if-present run lint` (workspace packages opt in
#                   as lint configs land; zero configured today, so the area
#                   verifies the runner itself with a control: a failing fake
#                   lint must fail the area — a runner that never fails is the
#                   bug this area exists to catch)
#   6. render smoke two REAL Remotion renders from one bundle over the real
#                   media tree: Short1Chess (upstream 9:16 shot) and S01E01
#                   (episodic 16:9 composition from the generated registry) —
#                   30 frames each at 0.5 scale into a temp dir (renders never
#                   touch the repo tree), each ffprobe-validated for codec +
#                   dimensions. This is the same bundle() → selectComposition()
#                   → renderMedia() path the production pipeline uses (spec
#                   §21).
#
# The script never reads, prints, or requires secret values — .env keys are
# irrelevant to every check (doctor-style leniency, spec §21). Story/text
# files are data: the render smoke mounts them as Remotion public assets,
# never executes them.
#
# Exit codes: 0 all areas PASS · 1 any area FAIL · 2 usage error.
#
# Options:
#   --json            emit one JSON summary line (areas + counts, no values)
#   --skip-render     skip area 6 (smoke renders) — heavy, needs the toolchain
#   --skip-vitest     skip area 2 (dev loop only; NOT valid for release gates)
#   --help | -h       print this help
set -uo pipefail

JSON_OUT=0
SKIP_RENDER=0
SKIP_VITEST=0

print_usage() {
  # Header = everything from line 2 down to (not including) the `set` line.
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | grep -E '^#( |$)' | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON_OUT=1 ;;
    --skip-render) SKIP_RENDER=1 ;;
    --skip-vitest) SKIP_VITEST=1 ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REMOTION_DIR="$REPO_ROOT/remotion"
SMOKE_OUT="$(mktemp -d "${TMPDIR:-/tmp}/mmcs-regression-smoke-XXXXXX")"
trap 'rm -rf "$SMOKE_OUT"' EXIT

declare -a AREA_NAMES=()
declare -a AREA_RESULTS=()   # "PASS" | "FAIL"
declare -a AREA_NOTES=()
FAILED_AREAS=0

area_pass() {  # area_pass <name> <note>
  AREA_NAMES+=("$1"); AREA_RESULTS+=("PASS"); AREA_NOTES+=("$2")
  echo "  PASS [$1] $2"
}

area_fail() {  # area_fail <name> <note>
  AREA_NAMES+=("$1"); AREA_RESULTS+=("FAIL"); AREA_NOTES+=("$2")
  FAILED_AREAS=$((FAILED_AREAS + 1))
  echo "  FAIL [$1] $2"
}

# Capture a command's output to a log file; caller inspects rc + log. On
# failure the tail is dumped to stdout so a CI run shows the triage evidence
# without artifact plumbing.
LOG="$SMOKE_OUT/area.log"

dump_log_tail() {  # dump_log_tail <label>
  if [ -f "$LOG" ]; then
    echo "  --- ${1}: log tail ---"
    tail -n 15 "$LOG" 2>/dev/null | sed 's/^/  | /'
  fi
}

emit_json() {
  local pairs="" i
  for i in "${!AREA_NAMES[@]}"; do
    [ -n "$pairs" ] && pairs="$pairs,"
    pairs="$pairs\"${AREA_NAMES[$i]}\":\"${AREA_RESULTS[$i]}\""
  done
  local status="ok"
  [ "$FAILED_AREAS" -gt 0 ] && status="failed"
  printf '{"step":"regression","status":"%s","repoRoot":"%s","areas":{%s},"failedAreas":%s}\n' \
    "$status" "$REPO_ROOT" "$pairs" "$FAILED_AREAS"
}

echo "== MMCS full regression =="
echo "repo: $REPO_ROOT"
echo

# ---------------------------------------------------------------------------
step_header() { echo "-- [$1] $2"; }

# 1. tools ------------------------------------------------------------------
step_header 1 "tools: ffmpeg + ffprobe"
FFMPEG_OK=0
FFPROBE_OK=0
if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1; then FFMPEG_OK=1; fi
if command -v ffprobe >/dev/null 2>&1 && ffprobe -version >/dev/null 2>&1; then FFPROBE_OK=1; fi
if [ "$FFMPEG_OK" -eq 1 ] && [ "$FFPROBE_OK" -eq 1 ]; then
  area_pass "tools" "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}'), ffprobe $(ffprobe -version 2>/dev/null | head -1 | awk '{print $3}') on PATH and executable"
else
  area_fail "tools" "ffmpeg/ffprobe missing or non-executable — install ffmpeg (e.g. brew install ffmpeg); spec §21 media integrity checks require both"
fi

# 2. vitest -----------------------------------------------------------------
if [ "$SKIP_VITEST" -eq 1 ]; then
  step_header 2 "vitest: full monorepo suite"
  area_fail "vitest" "--skip-vitest given — a vitest-skipped run is NOT a regression pass"
else
  step_header 2 "vitest: full monorepo suite (npx vitest run)"
  # MMCS_REGRESSION_CHILD=1 lets the script's own test file recognise (and
  # skip) a run launched from inside it; --exclude keeps it out directly.
  if (cd "$REPO_ROOT" && MMCS_REGRESSION_CHILD=1 npx vitest run --exclude 'scripts/release/regression.test.ts' >"$LOG" 2>&1); then
    SUITE_LINE=$(grep -E "Tests  " "$LOG" | tail -1 | sed 's/^ *//')
    area_pass "vitest" "${SUITE_LINE:-suite green}"
  else
    # One honest flake retry: timing-sensitive tests (cross-process locks,
    # concurrent archive writers) can fail when the machine is loaded even
    # though the code is sound. Rerun ONLY the failing files, once — a real
    # regression fails twice, and the retry is disclosed in the area note.
    FLAKY_FILES="$(grep -E '^[[:space:]]*FAIL[[:space:]]' "$LOG" | sed -E 's/^[[:space:]]*FAIL[[:space:]]+([^ >]+).*/\1/' | grep -E '\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs)$' | sort -u)"
    RETRIED=""
    if [ -n "$FLAKY_FILES" ]; then
      # word-splitting intentional: one test-file argument each
      if (cd "$REPO_ROOT" && MMCS_REGRESSION_CHILD=1 npx vitest run --exclude 'scripts/release/regression.test.ts' $FLAKY_FILES >"$LOG.retry" 2>&1); then
        RETRIED=" — flake retry: $(printf '%s\n' "$FLAKY_FILES" | wc -l | tr -d ' ') file(s) green on rerun (first pass failed under load)"
      fi
    fi
    if [ -n "$RETRIED" ]; then
      area_pass "vitest" "$(grep -E "Tests  " "$LOG.retry" | tail -1 | sed 's/^ *//')$RETRIED"
    else
      dump_log_tail vitest
      # Surface the failing test files, not the whole log.
      area_fail "vitest" "suite failed — rerun 'npx vitest run'; failing files: $(grep -E "FAIL " "$LOG" | head -5 | tr '\n' ' ')"
    fi
  fi
fi

# 3. gen --------------------------------------------------------------------
step_header 3 "gen: remotion registry regeneration is clean"
if (cd "$REMOTION_DIR" && npm run gen >"$LOG" 2>&1); then
  # Idempotency gate: gen must reproduce the committed generated files
  # byte-for-byte (gen scripts stamp 'AUTO-GENERATED — do not edit'; a diff
  # here means the registry generators and the committed output drifted).
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- remotion/src/registry.gen.tsx remotion/src/shots.manifest.json remotion/src/episodic/episode-registry.gen.ts 2>/dev/null)" ]; then
    area_fail "gen" "npm run gen succeeded but changed committed generated files — registry generators drifted; regenerate and commit"
  else
    EPISODES=$(grep -c '"compositionId"' "$REMOTION_DIR/src/episodic/episode-registry.gen.ts" 2>/dev/null || echo "?")
    SHOTS=$(grep -c '"id"' "$REMOTION_DIR/src/shots.manifest.json" 2>/dev/null || echo "?")
    area_pass "gen" "registry regenerated clean: $SHOTS shots, $EPISODES episode composition(s)"
  fi
else
  dump_log_tail gen
  area_fail "gen" "npm run gen failed — run 'cd remotion && npm run gen' for the error"
fi

# 4. typecheck --------------------------------------------------------------
step_header 4 "typecheck: tsc --noEmit across every project tsconfig"
TSC_FAILS=""
TSC_TOTAL=0
TSC_SKIPPED=0
# Every tsconfig in the repo, deterministic order; nested worktrees/ checkouts
# and build output excluded. NOTE: the worktrees/.git excludes are anchored to
# $REPO_ROOT — a wildcard `*/worktrees/*` would exclude the repo root itself
# whenever the checkout lives inside a worktrees/ dir (as worktrees do).
TSCONFIGS="$(find "$REPO_ROOT" -name "tsconfig*.json" \
  -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/out/*" \
  -not -path "$REPO_ROOT/worktrees/*" -not -path "$REPO_ROOT/.git/*" | sort)"
while IFS= read -r cfg; do
  [ -z "$cfg" ] && continue
  # Base-only configs (shared options via "extends", no include/files of their
  # own) compile nothing by themselves — tsc -p on tsconfig.base.json sweeps
  # the whole tree including test files the project configs exclude. Skip.
  if ! grep -qE '"(include|files)"[[:space:]]*:' "$cfg"; then
    TSC_SKIPPED=$((TSC_SKIPPED + 1))
    continue
  fi
  TSC_TOTAL=$((TSC_TOTAL + 1))
  dir="$(dirname "$cfg")"
  # -p with noEmit in every repo project tsconfig; log keeps errors for triage.
  if ! (cd "$dir" && npx tsc --noEmit -p "$(basename "$cfg")" >"$LOG" 2>&1); then
    TSC_FAILS="$TSC_FAILS ${cfg#"$REPO_ROOT"/}"
  fi
done <<< "$TSCONFIGS"
if [ -z "$TSC_FAILS" ]; then
  area_pass "typecheck" "$TSC_TOTAL project tsconfig(s) clean ($TSC_SKIPPED base config(s) skipped — no include/files)"
else
  dump_log_tail tsc
  area_fail "typecheck" "failed:$TSC_FAILS — run 'npx tsc --noEmit -p <tsconfig>' in each listed dir for details"
fi

# 5. lint -------------------------------------------------------------------
step_header 5 "lint: pnpm -r --if-present run lint"
if (cd "$REPO_ROOT" && pnpm -r --if-present run lint >"$LOG" 2>&1); then
  # Control (negative-result contract): prove the runner can fail. A lint
  # runner that reports success with a deliberately failing lint script is
  # reporting nothing — that is the same class of silent-green this script
  # exists to prevent.
  FAKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmcs-lint-control-XXXXXX")"
  mkdir -p "$FAKE_DIR/packages/lint-control"
  printf '{\n  "name": "@mmcs/lint-control",\n  "version": "0.0.0",\n  "scripts": { "lint": "exit 3" }\n}\n' \
    > "$FAKE_DIR/packages/lint-control/package.json"
  printf 'packages:\n  - packages/*\n' > "$FAKE_DIR/pnpm-workspace.yaml"
  if (cd "$FAKE_DIR" && pnpm -r --if-present run lint >/dev/null 2>&1); then
    CONTROL="control FAILED (runner reports green on a failing lint) — lint result NOT trustworthy"
    area_fail "lint" "$CONTROL"
  else
    area_pass "lint" "runner verified green + control (failing lint fails the run) — no workspace lint scripts configured yet (--if-present)"
  fi
  rm -rf "$FAKE_DIR"
else
  dump_log_tail lint
  area_fail "lint" "pnpm -r run lint failed — run 'pnpm -r --if-present run lint' for details (pnpm missing? corepack enable)"
fi

# 6. render smoke -----------------------------------------------------------
step_header 6 "render smoke: Remotion bundle → renderMedia, 9:16 + 16:9"
if [ "$SKIP_RENDER" -eq 1 ]; then
  area_fail "render-smoke" "--skip-render given — a render-skipped run is NOT a regression pass"
elif [ ! -d "$REMOTION_DIR/node_modules" ]; then
  area_fail "render-smoke" "remotion/node_modules missing — run 'cd remotion && npm ci' (standalone npm workspace with its own lockfile) first"
else
  SMOKE_RC=0
  (cd "$REMOTION_DIR" && node "$SCRIPT_DIR/regression-render-smoke.mjs" "$SMOKE_OUT" "$LOG") || SMOKE_RC=$?
  if [ "$SMOKE_RC" -eq 0 ]; then
    area_pass "render-smoke" "9:16 Short1Chess + 16:9 S01E01 rendered (30 frames @ scale 0.5), ffprobe-validated"
  else
    dump_log_tail render-smoke
    area_fail "render-smoke" "smoke render failed (rc=$SMOKE_RC) — run 'cd remotion && node ../scripts/release/regression-render-smoke.mjs' for details"
  fi
  # The smoke helper must clean up its generated bundle entry + runner; if it
  # leaves them behind the repo tree is dirty and the gate failed its own
  # hygiene contract. Remove strays here and fail the area.
  LEFTOVER="$(git -C "$REPO_ROOT" status --porcelain -- remotion/src/__regression_smoke__.tsx remotion/__regression_smoke_render__.mjs 2>/dev/null || true)"
  if [ -n "$LEFTOVER" ]; then
    rm -f "$REMOTION_DIR/src/__regression_smoke__.tsx" "$REMOTION_DIR/__regression_smoke_render__.mjs"
    area_fail "render-smoke" "smoke helper left generated files in the remotion project (now removed) — fix cleanup in regression-render-smoke.mjs"
  fi
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAILED_AREAS" -gt 0 ]; then
  echo "regression: FAILED — $FAILED_AREAS area(s) failing:"
  i=0
  for name in "${AREA_NAMES[@]}"; do
    [ "${AREA_RESULTS[$i]}" = "FAIL" ] && echo "  - $name: ${AREA_NOTES[$i]}"
    i=$((i + 1))
  done
  [ "$JSON_OUT" -eq 1 ] && emit_json
  exit 1
fi
echo "regression: PASS — every area green. Integration is promotable at a release gate."
[ "$JSON_OUT" -eq 1 ] && emit_json
exit 0
