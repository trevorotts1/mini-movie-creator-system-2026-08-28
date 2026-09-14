#!/usr/bin/env bash
# env-preflight.sh — MMCS environment readiness gate (skill 75 companion).
#
# Checks the runtime the engine needs and REPAIRS what it safely can, then
# re-verifies. Never reads or prints secret values — variables are presence
# and version checks only (spec §21, §24).
#
# Checks: node >= 20 (engines floor), git, ffmpeg + ffprobe, python3 (engine
# tools/ + the installer's routing-map insert), tsx (the committed .claude
# hooks), chromium (the Remotion renderer), remotion deps, built mmcs CLI.
# Fixes: node by sourcing an installed nvm.sh (opt-in), ffmpeg via apt (Linux
# root) or brew (macOS), remotion deps via npm ci --include=dev (the container
# trap). Anything unfixable without help → prints the exact remedy, exits 2
# (BLOCKED). The nvm fix is deliberately honest about the one case it cannot
# serve: nvm is an interactive shell FUNCTION, so this non-interactive script
# can only use it by sourcing its loader script.
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
    -h|--help) sed -n '1,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# nvm has no binary to resolve: it is a shell FUNCTION defined by a loader
# script (nvm.sh). `command -v nvm` therefore NEVER succeeds in this
# non-interactive script — the previous --fix branch was dead code that
# reported a fix path it could not take. Load nvm the way its installer
# documents (source the loader) from the known install roots.
find_nvm_sh() {
  local p
  for p in "${NVM_DIR:-}" "$HOME/.nvm" /usr/local/opt/nvm /opt/homebrew/opt/nvm /usr/local/nvm; do
    if [ -n "$p" ] && [ -s "$p/nvm.sh" ]; then printf '%s\n' "$p/nvm.sh"; return 0; fi
  done
  return 1
}

NM="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ -n "$NM" ] && [ "$NM" -ge 20 ] 2>/dev/null; then
  ok "node $(node --version 2>/dev/null) >= 20"
else
  NVM_SH="$(find_nvm_sh || true)"
  if [ "$FIX" -eq 1 ] && [ -n "$NVM_SH" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    . "$NVM_SH" >/dev/null 2>&1 || true
    if command -v nvm >/dev/null 2>&1; then
      nvm install --lts >/dev/null 2>&1 || true
      NM="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
      if [ -n "$NM" ] && [ "$NM" -ge 20 ] 2>/dev/null; then
        ok "node $(node --version) >= 20 (via nvm)"
      else
        bad "node >= 20 — nvm at $NVM_SH ran but installed no >= 20 runtime; try 'nvm install --lts' interactively and check the nvm error output"
      fi
    else
      bad "node >= 20 — $NVM_SH exists but did not load in this non-interactive shell; run 'nvm install --lts' in an interactive shell"
    fi
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

# --- python3 (engine tools/ + install-client.sh routing-map insert) ---
# tools/*.py (capture_web, cutout, gen_image, gen_voice, ...) are the engine's
# media helpers, and install-client.sh cannot register the skill in the client
# routing map without python3 — both are silent failures later if unchecked.
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  bad "python3 required — engine tools/*.py and the skill installer's routing-map insert need it; Linux: apt-get install -y python3 · macOS: brew install python3"
fi

# --- tsx (the committed .claude hooks run scripts/hooks/*.ts through it) ---
# Resolution mirrors .claude/hooks/post-compact.sh: PATH, then the repo-local
# bin, then the npx cache the hooks fall back to. Without one of those the
# pre/post-compact and session hooks need network (npx) or fail outright.
TSX_BIN="$(command -v tsx 2>/dev/null || true)"
if [ -z "$TSX_BIN" ] && [ -x "$REPO/node_modules/.bin/tsx" ]; then
  TSX_BIN="$REPO/node_modules/.bin/tsx"
fi
if [ -z "$TSX_BIN" ]; then
  for d in "$HOME"/.npm/_npx/*/node_modules/.bin; do
    if [ -x "$d/tsx" ]; then TSX_BIN="$d/tsx"; break; fi
  done
fi
if [ -n "$TSX_BIN" ]; then
  ok "tsx runner ($TSX_BIN) — .claude hooks can run scripts/hooks/*.ts"
else
  bad "tsx required by the committed .claude hooks (pre/post-compact, session start/end) — declare it at the repo root (pnpm add -D -w tsx) or seed the npx cache once"
fi

# --- chromium (Remotion renders through a Chrome/Chromium binary) ---
# Accept any system Chrome/Chromium, else Remotion's own Chrome Headless Shell
# in the project-local .remotion cache — the download the render pipeline makes
# on demand. Checked here because a missing browser only surfaces at render
# time, after paid media generation has already been spent.
CHROME_BIN="$(command -v chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null | head -1 || true)"
if [ -z "$CHROME_BIN" ]; then
  for b in "$REPO"/remotion/node_modules/.remotion/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell; do
    if [ -x "$b" ]; then CHROME_BIN="$b"; break; fi
  done
fi
if [ -n "$CHROME_BIN" ]; then
  ok "chromium (Remotion renderer: $CHROME_BIN)"
else
  bad "chromium required for rendering — cd remotion && npx remotion browser ensure (downloads Chrome Headless Shell), or install chromium/google-chrome"
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
