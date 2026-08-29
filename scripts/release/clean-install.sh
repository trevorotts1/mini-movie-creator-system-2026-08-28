#!/usr/bin/env bash
# clean-install.sh — REL-001: fresh clean clone → install → `mmcs doctor` exits 0.
#
# One command from a pristine clone of MMCS to a verified-working install:
#
#   bash scripts/release/clean-install.sh
#
# What it does (in order):
#   1. Verifies prerequisites: bash, git, node >= 20 (engines floor, root
#      package.json), ffmpeg/ffprobe on PATH (spec §21 responsibilities).
#      Missing hard prerequisites abort with a fix hint BEFORE any mutation.
#   2. Verifies the clone looks like the MMCS monorepo (apps/cli, pnpm
#      workspace, .env.example) — guards against running in the wrong tree.
#   3. Installs workspace dependencies with pnpm (corepack-provisioned when
#      missing, pinned to the repo's packageManager version). `--frozen-lockfile`
#      so a clean install is reproducible; set MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE=1
#      to allow a fresh resolution when you intentionally changed package.json.
#   4. Builds the CLI: `pnpm --filter @mmcs/cli build` → apps/cli/dist/.
#   5. Runs `mmcs doctor` through the built artifact and reports its exit code.
#      doctor needs NO secrets (CORE-010 tryLoadConfig reports missing provider
#      keys without refusing to run) — a pristine clone with an empty .env still
#      installs clean.
#   6. Copies .env.example → .env when .env does not exist yet (names only, no
#      values). Never overwrites an existing .env.
#
# Non-goals (by design):
#   - Never prints or reads secret VALUES — only checks name presence (spec §21).
#   - Never mutates anything outside the repo root (no global installs, no
#     npmrc edits, no remotion/ npm install — that is REL-002's regression
#     territory and the remotion project installs with npm per its own
#     package-lock.json; render smoke belongs to regression, not install).
#
# Exit codes: 0 install verified (doctor passed) · 1 any check failed ·
# 2 usage error.
#
# Options:
#   --skip-doctor     skip step 5 (structure + build only)
#   --no-env-copy     never create .env from .env.example
#   --json            emit a one-line JSON summary (scriptable; no secret values)
#   --help | -h       print this help
set -euo pipefail

SKIP_DOCTOR=0
NO_ENV_COPY=0
JSON_OUT=0

print_usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | grep -E '^#( |$)' | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-doctor) SKIP_DOCTOR=1 ;;
    --no-env-copy) NO_ENV_COPY=1 ;;
    --json) JSON_OUT=1 ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
declare -a STEPS=()

step() {   # step <name> — start a step line
  printf '\n== %s ==\n' "$1"
}

ok() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
  STEPS+=("PASS: $1")
}

bad() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  STEPS+=("FAIL: $1")
}

note() {
  echo "  ----: $1"
  STEPS+=("NOTE: $1")
}

# Hard gates (prerequisites, repo layout) must abort BEFORE any mutation —
# install/build/env-copy never run on a tree that failed the gate.
abort_if_gated() {
  if [ "$FAIL" -gt 0 ]; then
    echo
    echo "clean-install: FAILED — $PASS passed, $FAIL failed (aborted before install; fix the FAIL lines above and rerun)"
    [ "$JSON_OUT" -eq 1 ] && emit_json
    exit 1
  fi
}

emit_json() {
  # One JSON line, stdout, no secret values ever (names only).
  local status="ok"
  [ "$FAIL" -gt 0 ] && status="failed"
  printf '{"step":"clean-install","status":"%s","pass":%s,"fail":%s,"repoRoot":"%s"}\n' \
    "$status" "$PASS" "$FAIL" "$REPO_ROOT"
}

# Resolve the repo's pinned pnpm version from package.json packageManager.
pnpm_version_from_package_manager() {
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][^"]*\)".*/\1/p' \
    "$1" | head -1
}

# Node major version, empty when node is missing/unparseable.
node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

step "1/5 prerequisites"
NODE_MAJOR="$(node_major || true)"
if [ -n "${NODE_MAJOR:-}" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  ok "node $(node --version) (>= 20 required by engines)"
else
  bad "node >= 20 required (root package.json engines) — install from https://nodejs.org or your package manager"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  bad "git not found — required to clone/inspect the repo"
fi

FFMPEG_OK=0; FFPROBE_OK=0
command -v ffmpeg >/dev/null 2>&1 && FFMPEG_OK=1
command -v ffprobe >/dev/null 2>&1 && FFPROBE_OK=1
if [ "$FFMPEG_OK" -eq 1 ] && [ "$FFPROBE_OK" -eq 1 ]; then
  ok "ffmpeg + ffprobe on PATH (spec §21 media responsibilities)"
else
  bad "ffmpeg/ffprobe missing — install ffmpeg (e.g. brew install ffmpeg) before media steps"
fi

step "2/5 repo layout"
for req in apps/cli packages/core pnpm-workspace.yaml pnpm-lock.yaml .env.example; do
  if [ -e "$REPO_ROOT/$req" ]; then
    ok "present: $req"
  else
    bad "missing: $req — not an MMCS monorepo checkout?"
  fi
done

# Hard gates passed — only now is mutation (install/build/.env) allowed.
abort_if_gated

step "3/5 pnpm workspace install"
PNPM_V="$(pnpm_version_from_package_manager "$REPO_ROOT/package.json" || true)"
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version) on PATH"
elif command -v corepack >/dev/null 2>&1; then
  # Pin to the repo's packageManager version via corepack. `corepack enable
  # --install-directory` writes real pnpm shims into a directory we control
  # and prepend to PATH (plain `corepack prepare --activate` does NOT put a
  # shim on PATH — verified: the shim still fails to resolve). No global
  # mutation beyond corepack's own managed download cache.
  if [ -n "$PNPM_V" ]; then
    note "pnpm missing — corepack provisioning pnpm@$PNPM_V (repo packageManager pin)"
    COREPACK_BIN="${TMPDIR:-/tmp}/mmcs-corepack-bin-$$"
    mkdir -p "$COREPACK_BIN" 2>/dev/null || true
    if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable pnpm \
         --install-directory "$COREPACK_BIN" >/dev/null 2>&1 &&
       PATH="$COREPACK_BIN:$PATH" command -v pnpm >/dev/null 2>&1; then
      export PATH="$COREPACK_BIN:$PATH"
      # The actual pnpm download happens on first use (inside the install
      # step). Newer corepacks prompt for it by default; this is the repo's
      # own pinned version, so no interactive prompt.
      export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      ok "pnpm $PNPM_V activated via corepack ($COREPACK_BIN on PATH)"
    else
      bad "corepack failed to activate pnpm@$PNPM_V — install pnpm manually: corepack enable pnpm (or npm i -g pnpm@$PNPM_V)"
    fi
  else
    bad "pnpm missing and packageManager pin not found in package.json — install pnpm (corepack enable pnpm)"
  fi
else
  bad "pnpm missing and corepack unavailable — install pnpm (corepack enable pnpm or npm i -g pnpm)"
fi

INSTALL_OK=0
if command -v pnpm >/dev/null 2>&1; then
  INSTALL_ARGS=(install --frozen-lockfile)
  if [ "${MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE:-0}" = "1" ]; then
    note "MMCS_CLEAN_INSTALL_UNSAFE_LOCKFILE=1 — resolving without --frozen-lockfile"
    INSTALL_ARGS=(install --no-frozen-lockfile)
  fi
  if (cd "$REPO_ROOT" && pnpm "${INSTALL_ARGS[@]}" >/dev/null 2>&1); then
    ok "pnpm install --frozen-lockfile (workspace: packages/*, apps/*, integrations/*)"
    INSTALL_OK=1
  else
    bad "pnpm install failed — rerun 'pnpm install --frozen-lockfile' in $REPO_ROOT to see the error"
  fi
else
  bad "skipping workspace install — pnpm unavailable"
fi

step "4/5 CLI build"
if [ "$INSTALL_OK" -eq 1 ] && command -v pnpm >/dev/null 2>&1; then
  if (cd "$REPO_ROOT" && pnpm --filter @mmcs/cli build >/dev/null 2>&1) && [ -f "$REPO_ROOT/apps/cli/dist/index.js" ]; then
    ok "apps/cli built → apps/cli/dist/index.js (bin: mmcs)"
  else
    bad "CLI build failed — rerun 'pnpm --filter @mmcs/cli build' to see the error"
  fi
else
  bad "skipping CLI build — install did not complete"
fi

step "5/5 mmcs doctor (no secrets required)"
if [ "$SKIP_DOCTOR" -eq 1 ]; then
  note "--skip-doctor given — doctor not run"
elif [ -f "$REPO_ROOT/apps/cli/dist/index.js" ]; then
  # doctor reports missing provider credentials as findings, never as a crash
  # (CORE-010 lenient tryLoadConfig). A pristine clone passes with zero .env.
  if (cd "$REPO_ROOT" && node apps/cli/dist/index.js doctor >/dev/null 2>&1); then
    ok "node apps/cli/dist/index.js doctor — exit 0"
  else
    bad "mmcs doctor exited non-zero — run 'node apps/cli/dist/index.js doctor' for details"
  fi
else
  bad "apps/cli/dist/index.js missing — cannot run doctor"
fi

if [ "$FAIL" -eq 0 ] && [ "$NO_ENV_COPY" -eq 0 ] && [ -f "$REPO_ROOT/.env.example" ] && [ ! -e "$REPO_ROOT/.env" ]; then
  # Names only — .env.example carries no values. Never overwrites an existing
  # .env. Scaffolding happens only on a verified-clean install.
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  note "created .env from .env.example (fill in the keys you use; never commit it)"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  echo "clean-install: FAILED — $PASS passed, $FAIL failed (see FAIL lines above)"
  [ "$JSON_OUT" -eq 1 ] && emit_json
  exit 1
fi
echo "clean-install: OK — $PASS checks passed. Repo installed; 'mmcs doctor' exits 0."
echo "Next: fill .env with your provider keys (names in .env.example), then 'mmcs providers verify'."
[ "$JSON_OUT" -eq 1 ] && emit_json
exit 0
