#!/usr/bin/env bash
# SKR-033: prove the render works on Linux, inside the image, rather than assuming it.
#
# This is the Linux counterpart to the macOS render smoke. It drives the SAME helper
# (scripts/release/regression-render-smoke.mjs) so both platforms exercise one contract:
# bundle() -> selectComposition() -> renderMedia(), then ffprobe-validate the output.
# Running inside docker/Dockerfile.render is the point — that image is the only place the
# LINUX @remotion/compositor-* binary and the Linux headless Chrome exist.
#
# Exits 0 only when both compositions render AND ffprobe reports the expected geometry.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$(mktemp -d)}"
LOG="$OUT_DIR/linux-render.log"
mkdir -p "$OUT_DIR"

fail() { echo "linux-render-check: FAIL — $1" >&2; exit 1; }

echo "== MMCS Linux render check =="
echo "repo:     $REPO_ROOT"
echo "platform: $(uname -s -m)"

# 1. The whole point of the image: a Linux compositor must be installed. Assert it here too,
#    so a caller that mounts a macOS node_modules over the image gets a clear error rather
#    than an opaque render failure.
COMPOSITOR_DIR="$REPO_ROOT/remotion/node_modules/@remotion"
[ -d "$COMPOSITOR_DIR" ] || fail "remotion/node_modules/@remotion missing — the render workspace is not installed in this image"
FOUND="$(ls "$COMPOSITOR_DIR" 2>/dev/null | grep '^compositor-' || true)"
echo "compositor: ${FOUND:-'(none)'}"
case "$FOUND" in
  *compositor-linux-*) ;;
  *) fail "no LINUX compositor installed (found: ${FOUND:-none}) — install with --include=optional" ;;
esac

# 2. ffprobe must exist: the validation below depends on it.
command -v ffprobe >/dev/null 2>&1 || fail "ffprobe not on PATH"

# 3. Render both compositions through the shared helper.
echo "-- rendering (bundle -> selectComposition -> renderMedia)"
node "$REPO_ROOT/scripts/release/regression-render-smoke.mjs" "$OUT_DIR" "$LOG" \
  || { echo "--- render log tail ---"; tail -n 25 "$LOG" 2>/dev/null || true; fail "render helper failed"; }

# 4. ffprobe-validate every output.
probe() { # probe <file> <expected-width> <expected-height> <label>
  local f="$1" w="$2" h="$3" label="$4"
  [ -s "$f" ] || fail "$label: output missing or empty ($f)"
  local codec width height
  codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$f")"
  width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of default=nw=1:nk=1 "$f")"
  height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$f")"
  [ "$codec" = "h264" ] || fail "$label: expected h264, got '$codec'"
  [ "$width" = "$w" ] && [ "$height" = "$h" ] \
    || fail "$label: expected ${w}x${h}, got ${width}x${height}"
  echo "  $label: ${width}x${height} $codec OK"
}

probe "$OUT_DIR/__smoke_9x16.mp4" 540 960 "9:16 Short1Chess"
probe "$OUT_DIR/__smoke_16x9.mp4" 960 540 "16:9 S01E01"

echo "linux-render-check: PASS — both compositions rendered and ffprobe-validated on Linux"
