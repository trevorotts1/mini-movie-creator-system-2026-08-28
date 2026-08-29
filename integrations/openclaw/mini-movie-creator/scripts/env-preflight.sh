#!/usr/bin/env bash
# env-preflight.sh — MMCS environment readiness gate (skill 75 companion).
#
# Checks the runtime the engine needs and REPAIRS what it safely can, then
# re-verifies. Never reads or prints secret values — variables are presence
# and version checks only (spec §21, §24).
#
# Checks: node >= 20 (engines floor), git, ffmpeg + ffprobe, remotion deps,
# built mmcs CLI. Fixes: node via nvm/n (opt-in), ffmpeg via apt (Linux root)
# or brew (macOS), remotion deps via npm ci --include=dev (the container trap).
# Anything unfixable without help → prints the exact remedy, exits 2 (BLOCKED).
#
# Exit: 0 ready · 2 blocked (with remedy lines) · 127 never (guarded).
# Usage: bash env-preflight.sh [--fix] [--json]
set -uo pipefail

FIX=0
JSON=0
for a in "$@"; do
  case "$a" in
    --fix) FIX=1 ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '1,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

REPO=""
for c in "${MMCS_ROOT:-}" . /home/node/.openclaw/workspace/mmcs /home/node/mmcs; do
  if [ -n "$c" ] && [ -f "$c/package.json" ] && grep -q '"name": "mmcs-monorepo"' "$c/package.json" 2>/dev/null; then
    REPO="$c"; break
  fi
done
[ -n "$REPO" ] || { echo "BLOCKED: MMCS checkout not found (set MMCS_ROOT or clone the repo)"; exit 2; }

PASS=0; FAIL=0; declare -a LINES=()
ok()  { PASS=$((PASS+1)); LINES+=("PASS: $1"); }
bad() { FAIL=$((FAIL+1)); LINES+=("FAIL: $1"); }

# --- node ---
NM="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ -n "$NM" ] && [ "$NM" -ge 20 ] 2>/dev/null; then
  ok "node $(node --version 2>/dev/null) >= 20"
else
  if [ "$FIX" -eq 1 ] && command -v nvm >/dev/null 2>&1; then
    . "$(dirname "$(command -v nvm)")/../nvm.sh" 2>/dev/null; nvm install --lts >/dev/null 2>&1
    NM="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    [ -n "$NM" ] && [ "$NM" -ge 20 ] 2>/dev/null && ok "node $(node --version) >= 20 (via nvm)" || bad "node >= 20 (nvm install --lts then reopen shell)"
  else
    bad "node >= 20 required — install from https://nodejs.org or your package manager (nvm/n)"
  fi
fi

# --- git ---
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else bad "git — install git"; fi

# --- ffmpeg/ffprobe ---
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 \
   && ffmpeg -version >/dev/null 2>&1 && ffprobe -version >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}') + ffprobe on PATH"
else
  if [ "$FIX" -eq 1 ]; then
    if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ffmpeg >/dev/null 2>&1
    elif command -v brew >/dev/null 2>&1; then
      brew install ffmpeg >/dev/null 2>&1
    fi
  fi
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    ok "ffmpeg + ffprobe (installed)"
  else
    bad "ffmpeg + ffprobe required — Linux root: apt-get install -y ffmpeg · macOS: brew install ffmpeg"
  fi
fi

# --- remotion deps ---
if [ -d "$REPO/remotion/node_modules/@remotion" ] && [ -f "$REPO/remotion/node_modules/typescript/package.json" ]; then
  TSV="$(node -p "require('$REPO/remotion/node_modules/typescript/package.json').version" 2>/dev/null || echo '?')"
  case "$TSV" in 5.*) ok "remotion deps (ts $TSV, @remotion present)";; *) bad "remotion typescript $TSV — expected 5.x (see container trap: npm ci --include=dev)";; esac
else
  if [ "$FIX" -eq 1 ] && [ -d "$REPO/remotion" ]; then
    (cd "$REPO/remotion" && npm ci --include=dev --no-audit --no-fund >/dev/null 2>&1)
  fi
  if [ -f "$REPO/remotion/node_modules/typescript/package.json" ]; then
    ok "remotion deps installed"
  else
    bad "remotion deps missing — cd remotion && npm ci --include=dev"
  fi
fi

# --- built CLI ---
if [ -f "$REPO/apps/cli/dist/index.js" ]; then
  ok "mmcs CLI built ($REPO/apps/cli/dist/index.js)"
else
  if [ "$FIX" -eq 1 ] && command -v pnpm >/dev/null 2>&1; then
    (cd "$REPO" && pnpm --filter @mmcs/cli build >/dev/null 2>&1)
  fi
  [ -f "$REPO/apps/cli/dist/index.js" ] && ok "mmcs CLI built" || bad "mmcs CLI not built — pnpm --filter @mmcs/cli build"
fi

if [ "$JSON" -eq 1 ]; then
  echo "{\"ready\":$([ "$FAIL" -eq 0 ] && echo true || echo false),\"pass\":$PASS,\"fail\":$FAIL}"
else
  for l in "${LINES[@]}"; do echo "  $l"; done
  [ "$FAIL" -eq 0 ] && echo "env-preflight: READY" || { echo "env-preflight: BLOCKED — see FAIL lines"; exit 2; }
fi
