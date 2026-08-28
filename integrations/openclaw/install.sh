#!/usr/bin/env bash
# install.sh — install the MMCS skill into the active OpenClaw workspace (SKL-005).
#
# Resolution doctrine (spec §27, item 3): the ACTIVE WORKSPACE IS RESOLVED FROM
# OPENCLAW CONFIG — NEVER GUESSED. This script asks `openclaw config get` for
# the workspace of the default agent (agents.list[].workspace, falling back to
# agents.defaults.workspace). If OpenClaw cannot tell us, we abort — we do not
# pick a directory ourselves.
#
# Primary install form: `openclaw skills install <dir> --as mini-movie-creator
# --force` (the current CLI flow). Fallback: direct workspace placement at
# <workspace>/skills/mini-movie-creator (OpenClaw workspace skills have high
# precedence; the skill watcher picks up new workspace skills).
#
# Idempotent: re-running an already-correct install is a no-op.
#
# Usage:
#   install.sh                 # install into the config-resolved workspace
#   install.sh --check         # 0 = installed and listed; prints details
#   install.sh --uninstall     # remove the workspace-installed skill
#   install.sh --agent <id>    # target a specific agent's workspace
#   install.sh --placement     # force workspace-placement instead of CLI install
#
# Exit codes: 0 ok · 1 install/verify failure · 2 precondition failure
# (openclaw missing, config unreadable, workspace unresolved, skill missing).

set -u

SKILL_NAME="mini-movie-creator"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGING_DIR="$SCRIPT_DIR/mini-movie-creator"
MODE="install"
TARGET_AGENT=""
PLACEMENT_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --agent) [ "$#" -ge 2 ] || { echo "install.sh: --agent needs a value" >&2; exit 2; }
             TARGET_AGENT="$2"; shift 2 ;;
    --agent=*) TARGET_AGENT="${1#*=}"; shift ;;
    --placement) PLACEMENT_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

agent_flags=()
[ -n "$TARGET_AGENT" ] && agent_flags=(--agent "$TARGET_AGENT")

# --- preconditions -----------------------------------------------------------
fail() { echo "install.sh: $*" >&2; exit 2; }

command -v openclaw >/dev/null 2>&1 || fail "openclaw CLI not on PATH."
[ -f "$PACKAGING_DIR/SKILL.md" ] || fail "packaging missing: $PACKAGING_DIR/SKILL.md"
grep -q "^name: ${SKILL_NAME}$" "$PACKAGING_DIR/SKILL.md" \
  || fail "SKILL.md frontmatter name mismatch in $PACKAGING_DIR"

# --- resolve the active workspace FROM CONFIG (never guess) ------------------
config_get() { openclaw config get "$1" 2>/dev/null; }

resolve_workspace() {
  # 1. Agent-specific workspace from agents.list
  if [ -n "$TARGET_AGENT" ]; then
    local ws
    ws="$(config_get "agents.list" 2>/dev/null | MMCS_TARGET_AGENT="$TARGET_AGENT" python3 -c "
import json,sys,os
try:
    agents=json.load(sys.stdin)
except Exception:
    sys.exit(0)
want=os.environ.get('MMCS_TARGET_AGENT','')
for a in agents if isinstance(agents,list) else []:
    if a.get('id')==want and a.get('workspace'):
        print(a['workspace']); break
" 2>/dev/null)"
    [ -n "$ws" ] && { printf '%s' "$ws"; return 0; }
    fail "agents.list has no workspace for agent '$TARGET_AGENT' — refusing to guess."
  fi
  # 2. Default agent's workspace from agents.list (default: true)
  local ws
  ws="$(config_get "agents.list" 2>/dev/null | python3 -c "
import json,sys
try:
    agents=json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in agents if isinstance(agents,list) else []:
    if a.get('default') and a.get('workspace'):
        print(a['workspace']); break
" 2>/dev/null)"
  # 3. agents.defaults.workspace
  [ -z "$ws" ] && ws="$(config_get "agents.defaults.workspace" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$ws" ] || [ "$ws" = "null" ] && ws=""
  [ -n "$ws" ] || fail "OpenClaw config does not define an active workspace (agents.list default / agents.defaults.workspace). Resolve the config first — never guess a workspace path."
  printf '%s' "$ws"
}

WORKSPACE="$(resolve_workspace)"
[ -d "$WORKSPACE" ] || fail "resolved workspace '$WORKSPACE' does not exist on disk."
WORKSPACE_SKILLS="$WORKSPACE/skills"
DEST="$WORKSPACE_SKILLS/$SKILL_NAME"

# --- verify ------------------------------------------------------------------
# Scope-aware: this script owns the WORKSPACE install. `openclaw skills list`
# also rows skills from other scopes (openclaw-managed global dir, bundled) —
# a global install of the same slug must NOT satisfy workspace verification.
verify() {
  local out
  out="$(openclaw skills list "${agent_flags[@]}" 2>/dev/null || true)"
  if printf '%s\n' "$out" | grep "$SKILL_NAME" | grep -q "openclaw-workspace"; then
    echo "install.sh: OK — '$SKILL_NAME' listed by 'openclaw skills list' (workspace: $WORKSPACE)."
    return 0
  fi
  echo "install.sh: '$SKILL_NAME' NOT listed as an openclaw-workspace skill." >&2
  return 1
}

# --- check -------------------------------------------------------------------
if [ "$MODE" = "check" ]; then
  if [ -f "$DEST/SKILL.md" ]; then
    verify
    exit $?
  fi
  echo "install.sh: '$DEST/SKILL.md' not present — not installed (workspace: $WORKSPACE)." >&2
  exit 1
fi

# --- uninstall ---------------------------------------------------------------
if [ "$MODE" = "uninstall" ]; then
  if [ ! -e "$DEST" ]; then
    echo "install.sh: nothing to uninstall at $DEST."
    exit 0
  fi
  rm -rf "$DEST"
  echo "install.sh: removed $DEST."
  # The skill watcher may need a moment to notice the removal — poll briefly.
  listed=1
  for _ in 1 2 3 4 5 6; do
    if ! verify >/dev/null 2>&1; then listed=0; break; fi
    sleep 0.5
  done
  if [ "$listed" -ne 0 ]; then
    echo "install.sh: WARNING — '$SKILL_NAME' still listed after removal." >&2
    exit 1
  fi
  echo "install.sh: '$SKILL_NAME' no longer listed by 'openclaw skills list'."
  exit 0
fi

# --- already installed? -------------------------------------------------------
# Compare the WHOLE packaging tree (SKILL.md + references/ + scripts/), not
# just SKILL.md — a stale reference must not read as "up to date". The
# .openclaw/ marker written by the real CLI into installed skills is not part
# of the packaging and is excluded from the comparison.
if [ -f "$DEST/SKILL.md" ] && diff -qr --exclude=".openclaw" "$DEST" "$PACKAGING_DIR" >/dev/null 2>&1; then
  echo "install.sh: already installed and up to date at $DEST — no-op."
  verify
  exit $?
fi

# --- backup-before-overwrite ---------------------------------------------------
# Backup lives OUTSIDE <workspace>/skills/ — the skill watcher treats every
# directory under skills/ with a SKILL.md as a skill, and a .bak copy there
# shadows the live install in `openclaw skills info`.
if [ -e "$DEST" ]; then
  BAK_ROOT="$WORKSPACE/.mmcs-skill-backups"
  mkdir -p "$BAK_ROOT"
  BAK="$BAK_ROOT/$SKILL_NAME.bak-$(date +%Y%m%dT%H%M%S)"
  cp -R "$DEST" "$BAK"
  echo "install.sh: backed up existing install to $BAK."
fi

# --- install -------------------------------------------------------------------
if [ "$PLACEMENT_ONLY" -eq 0 ]; then
  echo "install.sh: primary form — openclaw skills install (current CLI flow)."
  if openclaw skills install "$PACKAGING_DIR" --as "$SKILL_NAME" --force "${agent_flags[@]}" >/dev/null 2>&1; then
    if verify; then exit 0; fi
    echo "install.sh: CLI install ran but skill not listed — falling back to workspace placement." >&2
  else
    echo "install.sh: 'openclaw skills install' unavailable/failed — using workspace placement." >&2
  fi
fi

# Workspace placement fallback: <workspace>/skills/mini-movie-creator
mkdir -p "$WORKSPACE_SKILLS"
rm -rf "$DEST"
cp -R "$PACKAGING_DIR" "$DEST"
chmod +x "$DEST/scripts/"*.sh 2>/dev/null
echo "install.sh: placed skill at $DEST."
verify
exit $?