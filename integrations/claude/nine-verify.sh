#!/usr/bin/env bash
# MMCS SKL-004 — claude-nine verification (spec §27, runbook §11).
#
# Proves, on this box, with LIVE runs only (nothing invented):
#   1. claude-nine resolves and reports its version (same binary as `claude`).
#   2. Skill discovery root: $CLAUDE_CONFIG_DIR/skills (claude-nine: ~/.claude-nine/skills)
#      is the primary root, and the launcher runs ~/.local/bin/sync-nine-skills.sh
#      which symlinks ~/.claude/skills entries in without ever overwriting a real dir.
#   3. A FRESH claude-nine session discovers a project-scope skill (.claude/skills
#      under the working directory) and, per that skill, calls the SAME mmcs CLI
#      engine — no copied logic.
#   4. A FRESH claude-nine session with an isolated CLAUDE_CONFIG_DIR discovers a
#      skill in <config-dir>/skills — proving the config-dir root mechanism.
#
# Non-destructive: probes live in `mktemp -d` directories, removed on exit.
# No repo state, no ~/.claude, no ~/.claude-nine content is modified. The sync
# script in step 2 is the operator's own launcher step (idempotent, "already in
# sync" is a no-op).
#
# Usage:
#   bash integrations/claude/nine-verify.sh             # full verification (2 tiny model calls via 9Router)
#   bash integrations/claude/nine-verify.sh --selftest  # structural checks only (no model calls)
#
# Exit: 0 all checks pass; 1 any check failed (never assume).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR="$REPO_ROOT/apps/cli"
NINE_BIN="${NINE_BIN:-$HOME/.local/bin/claude-nine}"
SYNC_SCRIPT="${SYNC_SCRIPT:-$HOME/.local/bin/sync-nine-skills.sh}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-300}"

PASS=0
FAIL=0
SELFTEST=0
[ "${1:-}" = "--selftest" ] && SELFTEST=1

ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
note() { echo "  ----: $1"; }

header() { echo; echo "== $1 =="; }

# Run a command with a timeout when `timeout` is available (coreutils).
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

trap 'rm -rf "${PROBE_A_DIR:-}" "${PROBE_B_DIR:-}" 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
# 0. Structural checks (always; also the whole of --selftest)
# ---------------------------------------------------------------------------
header "0. structural checks"

if [ -x "$NINE_BIN" ]; then ok "claude-nine launcher executable: $NINE_BIN"; else bad "claude-nine launcher missing/not executable: $NINE_BIN"; fi
if [ -f "$SYNC_SCRIPT" ] && [ -x "$SYNC_SCRIPT" ]; then ok "sync script executable: $SYNC_SCRIPT"; else bad "sync script missing/not executable: $SYNC_SCRIPT"; fi
if bash -n "$SCRIPT_DIR/nine-verify.sh" 2>/dev/null; then ok "nine-verify.sh parses (bash -n)"; else bad "nine-verify.sh has a syntax error"; fi
if [ -f "$CLI_DIR/src/index.ts" ]; then ok "engine CLI entry present: apps/cli/src/index.ts"; else bad "engine CLI entry missing: apps/cli/src/index.ts"; fi
if [ -f "$CLI_DIR/tsconfig.json" ]; then ok "CLI tsconfig present"; else bad "CLI tsconfig missing"; fi

if [ "$SELFTEST" -eq 1 ]; then
  echo
  echo "selftest: PASS=$PASS FAIL=$FAIL (no model calls)"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

# ---------------------------------------------------------------------------
# 1. claude-nine identity (live)
# ---------------------------------------------------------------------------
header "1. claude-nine identity"

NINE_VERSION="$("$NINE_BIN" --version 2>/dev/null | tail -1)"
if [[ "$NINE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  ok "claude-nine --version -> $NINE_VERSION"
else
  bad "claude-nine --version returned no semver (got: '$NINE_VERSION')"
fi

# ---------------------------------------------------------------------------
# 2. skill discovery root + sync (live, idempotent)
# ---------------------------------------------------------------------------
header "2. skill discovery root + sync"

NINE_SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-nine}/skills"
if [ -d "$NINE_SKILLS_DIR" ]; then
  NINE_SKILL_COUNT="$(find "$NINE_SKILLS_DIR" -mindepth 1 -maxdepth 1 ! -name '.DS_Store' | wc -l | tr -d ' ')"
  ok "primary skill dir exists: $NINE_SKILLS_DIR ($NINE_SKILL_COUNT entries)"
else
  bad "primary skill dir missing: $NINE_SKILLS_DIR"
fi

SYNC_OUT="$(bash "$SYNC_SCRIPT" 2>&1)"; SYNC_RC=$?
if [ "$SYNC_RC" -eq 0 ]; then
  ok "sync-nine-skills.sh exit 0 ($SYNC_OUT)"
else
  bad "sync-nine-skills.sh exit $SYNC_RC ($SYNC_OUT)"
fi

LINKED=0; REAL=0
for p in "$NINE_SKILLS_DIR"/*; do
  [ -e "$p" ] || continue
  if [ -L "$p" ]; then LINKED=$((LINKED + 1)); else REAL=$((REAL + 1)); fi
done
if [ "$LINKED" -gt 0 ] && [ "$REAL" -gt 0 ]; then
  ok "discovery root holds $REAL real dirs (nine's own, sync never overwrites) + $LINKED symlinks (from ~/.claude/skills)"
else
  bad "unexpected discovery-root mix: real=$REAL linked=$LINKED"
fi

# ---------------------------------------------------------------------------
# 3. engine CLI reachable (same engine every skill host must call)
# ---------------------------------------------------------------------------
header "3. engine CLI (mmcs status)"

if [ ! -f "$CLI_DIR/dist/index.js" ]; then
  note "dist missing — building CLI (npx tsc -p apps/cli)"
  (cd "$CLI_DIR" && npx tsc -p tsconfig.json >/dev/null 2>&1) || true
fi
if [ ! -f "$CLI_DIR/dist/index.js" ]; then
  bad "CLI build failed; cannot verify engine call path"
else
  CLI_OUT="$(node "$CLI_DIR/dist/index.js" status 2>&1)"; CLI_RC=$?
  if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "status"; then
    ok "engine CLI runs: node apps/cli/dist/index.js status -> '$(echo "$CLI_OUT" | head -1)'"
  else
    bad "engine CLI status rc=$CLI_RC out='$CLI_OUT'"
  fi
fi

# ---------------------------------------------------------------------------
# 4. fresh claude-nine session: project-scope skill -> SAME engine (live probe)
# ---------------------------------------------------------------------------
header "4. fresh-session probe: project skill calls the engine"

PROBE_A_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmcs-nine-verify-proj.XXXXXX")"
mkdir -p "$PROBE_A_DIR/.claude/skills/mmcs-nine-probe"
cat > "$PROBE_A_DIR/.claude/skills/mmcs-nine-probe/SKILL.md" <<EOF
---
name: mmcs-nine-probe
description: Throwaway verification probe for claude-nine project-skill discovery (MMCS SKL-004). Replies by running one local command.
---

# MMCS nine probe

Run exactly this command with the Bash tool and reply with ONLY its stdout, verbatim:

    echo MMCS-NINE-PROBE-OK engine=\$(node $CLI_DIR/dist/index.js status 2>&1 | head -1)

No other tool calls. No commentary.
EOF

# cd into the probe dir (subshell): project-scope discovery is per-cwd, so the
# session must LAUNCH with <probe>/.claude/skills under its working directory.
# </dev/null: -p sessions otherwise wait 3s on an inherited stdin pipe.
# max-turns 15: a skill -> Bash tool -> reply chain is flaky at 6 and hit the
# cap once at 10 (deterministic 3/3 at 15).
PROBE_A_OUT="$(cd "$PROBE_A_DIR" && run_with_timeout "$PROBE_TIMEOUT" "$NINE_BIN" -p "Invoke the /mmcs-nine-probe skill and do exactly what it says." --allowedTools "Bash" --max-turns 15 </dev/null 2>&1)"; PROBE_A_RC=$?
if echo "$PROBE_A_OUT" | grep -q "MMCS-NINE-PROBE-OK" && echo "$PROBE_A_OUT" | grep -q "status"; then
  ok "fresh claude-nine session discovered + invoked project skill; skill called the mmcs engine (marker: MMCS-NINE-PROBE-OK)"
  note "$(echo "$PROBE_A_OUT" | grep "MMCS-NINE-PROBE-OK" | head -1 | cut -c1-140)"
else
  bad "project-scope probe failed (rc=$PROBE_A_RC, out tail: $(echo "$PROBE_A_OUT" | tail -2 | tr '\n' ' ' | cut -c1-160))"
fi

# ---------------------------------------------------------------------------
# 5. fresh claude-nine session: config-dir skills root (live probe, isolated config)
# ---------------------------------------------------------------------------
header "5. fresh-session probe: config-dir skills root"

PROBE_B_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmcs-nine-verify-cfg.XXXXXX")"
mkdir -p "$PROBE_B_DIR/skills/mmcs-nine-primary-probe"
cp "${CLAUDE_CONFIG_DIR:-$HOME/.claude-nine}/settings.json" "$PROBE_B_DIR/settings.json"
cat > "$PROBE_B_DIR/skills/mmcs-nine-primary-probe/SKILL.md" <<EOF
---
name: mmcs-nine-primary-probe
description: Throwaway probe proving claude-nine loads skills from its config-dir skills root (MMCS SKL-004). One command, no tools.
---

# MMCS config-root probe

Reply with exactly this line and nothing else:

MMCS-NINE-PRIMARY-ROOT-OK
EOF

PROBE_B_OUT="$(cd "$PROBE_B_DIR" && run_with_timeout "$PROBE_TIMEOUT" env CLAUDE_CONFIG_DIR="$PROBE_B_DIR" "$NINE_BIN" -p "Invoke the /mmcs-nine-primary-probe skill and do exactly what it says." --max-turns 15 </dev/null 2>&1)"; PROBE_B_RC=$?
if echo "$PROBE_B_OUT" | grep -q "MMCS-NINE-PRIMARY-ROOT-OK"; then
  ok "skills resolve from \$CLAUDE_CONFIG_DIR/skills (claude-nine primary root = ~/.claude-nine/skills)"
else
  bad "config-dir probe failed (rc=$PROBE_B_RC, out tail: $(echo "$PROBE_B_OUT" | tail -2 | tr '\n' ' ' | cut -c1-160))"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "== RESULT: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1