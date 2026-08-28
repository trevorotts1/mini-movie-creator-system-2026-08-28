#!/usr/bin/env bash
#
# integrations/openclaw/global-install.sh — SKL-006
# OpenClaw OPTIONAL global install for the MMCS mini-movie-creator skill.
#
# The WORKSPACE install (SKL-005, integrations/openclaw/workspace-install/,
# skill placed under <workspace>/skills) remains the SUPPORTED DEFAULT.
# This script only provides the optional shared/global form:
#
#   openclaw skills install <source> --as mini-movie-creator --global --force
#
# which installs into the shared managed skills directory
# (<state-dir>/skills, default ~/.openclaw/skills) so every local agent can
# see the skill unless agent allowlists narrow it.
#
# Precedence (docs.openclaw.ai/tools/skills, verified live 2026-08-28):
#   1 highest  workspace skills    <workspace>/skills        <- supported default
#   2          project agent skills <workspace>/.agents/skills
#   3          personal agent skills ~/.agents/skills
#   4          managed/local skills <state-dir>/skills        <- this script installs here
#   5          bundled skills
#   6 lowest   extra dirs + plugin skills
# A workspace copy with the same name always WINS over the global copy.
#
# Uninstall/rollback: the current `openclaw skills` CLI has no uninstall
# subcommand (docs.openclaw.ai/cli/skills, verified live 2026-08-28), so
# uninstalling = removing the managed skill directory. This script does that
# with an automatic timestamped backup; the printed rollback is one `mv`.
#
# Usage:
#   bash integrations/openclaw/global-install.sh               # global install
#   bash integrations/openclaw/global-install.sh --check       # verify + self-test (mutates nothing)
#   bash integrations/openclaw/global-install.sh --uninstall   # remove global copy (backed up)
#   bash integrations/openclaw/global-install.sh --source DIR  # explicit skill source dir
#   bash integrations/openclaw/global-install.sh --help
#
# Environment:
#   OPENCLAW_STATE_DIR          OpenClaw state dir (default ~/.openclaw);
#                               managed skills live at <state-dir>/skills
#                               (honored by the CLI, verified live 2026-08-28)
#   MMCS_OPENCLAW_SKILL_SOURCE  default skill source dir override
#
# Secrets rules (spec §26/§29): this script prints paths and exit codes only —
# never env values, never config file contents.

set -euo pipefail

SKILL_SLUG="mini-movie-creator"
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log()  { printf '[openclaw-global] %s\n' "$*"; }
warn() { printf '[openclaw-global] WARNING: %s\n' "$*" >&2; }
die()  { printf '[openclaw-global] ERROR: %s\n' "$*" >&2; exit 2; }

usage() {
  cat <<EOF
OpenClaw OPTIONAL global install for the MMCS mini-movie-creator skill.

Usage:
  bash integrations/openclaw/global-install.sh [--source DIR]   global install
  bash integrations/openclaw/global-install.sh --check          verify + self-test (no mutation)
  bash integrations/openclaw/global-install.sh --uninstall      remove global copy (auto backup)
  bash integrations/openclaw/global-install.sh --help           this message

NOTE: the workspace install (integrations/openclaw/workspace-install) is the
supported default. Global install is optional.

Environment:
  OPENCLAW_STATE_DIR          state dir (default ~/.openclaw); managed skills
                              live at <state-dir>/skills
  MMCS_OPENCLAW_SKILL_SOURCE  default source dir override
EOF
}

# ---------------------------------------------------------------------------
# resolution helpers
# ---------------------------------------------------------------------------

state_dir() {
  if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
    printf '%s' "$OPENCLAW_STATE_DIR"
  else
    printf '%s' "$HOME/.openclaw"
  fi
}

managed_skills_dir() {
  printf '%s/skills' "$(state_dir)"
}

managed_skill_dir() {
  printf '%s/skills/%s' "$(state_dir)" "$SKILL_SLUG"
}

require_openclaw() {
  command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not found on PATH; install OpenClaw first (https://docs.openclaw.ai)"
  # The optional global form needs --global on `openclaw skills install`.
  openclaw skills install --help 2>&1 | grep -q -- '--global' \
    || die "installed openclaw does not support 'openclaw skills install --global'; upgrade OpenClaw or use the workspace install (SKL-005) instead"
}

# Resolve the skill source directory (must contain SKILL.md at its root,
# per docs.openclaw.ai/cli/skills for local installs).
resolve_source() {
  local candidate
  if [ -n "${SOURCE_FLAG:-}" ]; then
    candidate="$SOURCE_FLAG"
  elif [ -n "${MMCS_OPENCLAW_SKILL_SOURCE:-}" ]; then
    candidate="$MMCS_OPENCLAW_SKILL_SOURCE"
  elif [ -d "$REPO_ROOT/integrations/openclaw/$SKILL_SLUG" ]; then
    candidate="$REPO_ROOT/integrations/openclaw/$SKILL_SLUG"   # SKL-005 packaging
  elif [ -d "$REPO_ROOT/skills/$SKILL_SLUG" ]; then
    candidate="$REPO_ROOT/skills/$SKILL_SLUG"                  # SKL-001 canonical source
  else
    return 1
  fi
  [ -d "$candidate" ] || return 1
  [ -f "$candidate/SKILL.md" ] || return 1
  (cd "$candidate" && pwd)
}

# Read `openclaw skills list --json` on stdin; exit 0 (printing the source)
# when $1 is present (and equals $2 when $2 is non-empty), non-zero otherwise.
skill_source_from_json() {
  # stdin: `openclaw skills list --json` payload; $1 = skill name; $2 = required
  # source ("openclaw-managed") or "" for any. Prints the source on match.
  # NOTE: the code runs via -c (NOT a heredoc on `-`) because a heredoc would
  # replace the piped stdin the JSON arrives on.
  local code='
import json, sys
name, expected = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
skills = data.get("skills", []) if isinstance(data, dict) else data
if not isinstance(skills, list):
    sys.exit(1)
for s in skills:
    if isinstance(s, dict) and s.get("name") == name:
        src = s.get("source", "")
        if not expected or src == expected:
            print(src)
            sys.exit(0)
        sys.exit(2)
sys.exit(3)
'
  python3 -c "$code" "$1" "$2"
}

# `openclaw skills list --json`; SELFTEST_STATE_DIR (when set) retargets the
# inventory at the self-test's isolated state dir without affecting anything else.
list_json() {
  if [ -n "${SELFTEST_STATE_DIR:-}" ]; then
    OPENCLAW_STATE_DIR="$SELFTEST_STATE_DIR" openclaw skills list --json 2>/dev/null
  else
    openclaw skills list --json 2>/dev/null
  fi
}

backup_root() {
  printf '%s/skills/.mmcs-global-install-backups' "$(state_dir)"
}

# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------

cmd_install() {
  require_openclaw
  local source_dir target backup_dir ts
  source_dir="$(resolve_source)" \
    || die "no skill source found: pass --source DIR (containing SKILL.md), set MMCS_OPENCLAW_SKILL_SOURCE, or wait for SKL-001/SKL-005 to provide $REPO_ROOT/integrations/openclaw/$SKILL_SLUG"
  target="$(managed_skill_dir)"
  log "workspace install (<workspace>/skills) remains the supported default; installing OPTIONAL global copy"
  log "source:    $source_dir"
  log "target:    $target (shared managed skills dir)"

  if [ -e "$target" ] || [ -L "$target" ]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    backup_dir="$(backup_root)/$SKILL_SLUG-$ts"
    mkdir -p "$backup_dir"
    mv "$target" "$backup_dir/"
    log "existing global copy backed up to: $backup_dir"
  fi

  mkdir -p "$(managed_skills_dir)"
  # Run install + verify as one unit: ANY failure here restores the previous
  # copy so a half-installed or unverifiable state never replaces a working one.
  local install_ok=0
  if OPENCLAW_STATE_DIR="$(state_dir)" openclaw skills install \
      "$source_dir" --as "$SKILL_SLUG" --global --force \
      && [ -f "$target/SKILL.md" ] \
      && list_json | skill_source_from_json "$SKILL_SLUG" "openclaw-managed" >/dev/null; then
    install_ok=1
  fi
  if [ "$install_ok" -ne 1 ]; then
    if [ -n "${backup_dir:-}" ]; then
      rm -rf "$target" 2>/dev/null || true
      mv "$backup_dir/$SKILL_SLUG" "$target" 2>/dev/null \
        || die "install/verify failed and automatic restore failed; previous copy is at: $backup_dir"
      die "install/verify failed; previous global copy restored from $backup_dir"
    fi
    die "install/verify failed (no previous copy existed; nothing was replaced)"
  fi
  log "verified: '$SKILL_SLUG' visible with source openclaw-managed"
  log "done. uninstall/rollback: bash integrations/openclaw/global-install.sh --uninstall"
}

cmd_uninstall() {
  local target backup_dir ts
  target="$(managed_skill_dir)"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    log "nothing to uninstall: $target does not exist"
    log "note: a workspace copy (<workspace>/skills/$SKILL_SLUG) is managed by SKL-005 and is left untouched"
    return 0
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  backup_dir="$(backup_root)/$SKILL_SLUG-$ts"
  mkdir -p "$backup_dir"
  mv "$target" "$backup_dir/"
  log "removed global copy; backup at: $backup_dir"
  if command -v openclaw >/dev/null 2>&1; then
    if list_json | skill_source_from_json "$SKILL_SLUG" "" >/dev/null 2>&1; then
      warn "'$SKILL_SLUG' still listed after removal (a workspace copy may provide it — that copy wins by precedence and is NOT touched)"
    else
      log "verified: '$SKILL_SLUG' no longer in the managed inventory"
    fi
  else
    log "openclaw CLI unavailable; skipped inventory verification (managed dir removal is complete)"
  fi
  # The backup is the previous <target> itself, so rollback is a single mv of
  # the moved dir back into place (restores <target>/SKILL.md exactly).
  log "rollback: mv '$backup_dir/$SKILL_SLUG' '$target'"
}

cmd_check() {
  local failures=0
  log "check: workspace install (<workspace>/skills, SKL-005) remains the supported default; this global form is OPTIONAL"

  # 1. script syntax
  if bash -n "$SCRIPT_PATH" 2>/dev/null; then
    log "check: script syntax OK"
  else
    warn "check: script syntax FAILED"
    failures=$((failures + 1))
  fi

  # 2. openclaw present + --global supported (read-only help probe)
  if command -v openclaw >/dev/null 2>&1 \
      && openclaw skills install --help 2>&1 | grep -q -- '--global'; then
    log "check: openclaw CLI present with 'skills install --global'"
  else
    warn "check: openclaw CLI missing or lacks 'skills install --global'"
    failures=$((failures + 1))
  fi

  # 3. state dir resolution (print, do not create)
  log "check: state dir = $(state_dir) (managed skills at $(managed_skills_dir))"

  # 4. skill source status (informational — SKL-001/SKL-005 may land separately)
  if source_dir="$(resolve_source)"; then
    log "check: skill source = $source_dir"
  else
    log "check: skill source not present yet (SKL-001/SKL-005 pending); pass --source DIR to install a local build"
  fi

  # 5. end-to-end self-test in an isolated temp state dir: proves install,
  #    managed visibility, and the uninstall/rollback path with the real CLI.
  #    Mutates nothing outside the temp dir.
  local tmp fixture
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mmcs-openclaw-global-check.XXXXXX")"
  fixture="$tmp/fixture/$SKILL_SLUG"
  mkdir -p "$fixture"
  {
    printf -- '---\n'
    printf 'name: %s\n' "$SKILL_SLUG"
    printf 'description: MMCS global-install self-test fixture\n'
    printf -- '---\n'
    printf '# mini-movie-creator (self-test fixture)\n'
  } > "$fixture/SKILL.md"

  # The install command carries its own env override; the visibility probe
  # retargets through list_json's SELFTEST_STATE_DIR.
  if OPENCLAW_STATE_DIR="$tmp/state" openclaw skills install \
      "$fixture" --as "$SKILL_SLUG" --global --force >/dev/null 2>&1 \
      && [ -f "$tmp/state/skills/$SKILL_SLUG/SKILL.md" ] \
      && SELFTEST_STATE_DIR="$tmp/state" list_json | skill_source_from_json "$SKILL_SLUG" "openclaw-managed" >/dev/null; then
    log "check: self-test install --global -> managed dir + openclaw-managed visibility OK"
  else
    warn "check: self-test install/visibility FAILED"
    failures=$((failures + 1))
  fi

  # 6. uninstall/rollback path (remove managed dir; verify gone via inventory)
  rm -rf "$tmp/state/skills/$SKILL_SLUG"
  if SELFTEST_STATE_DIR="$tmp/state" list_json | skill_source_from_json "$SKILL_SLUG" "" >/dev/null 2>&1; then
    warn "check: self-test uninstall FAILED (skill still listed after removal)"
    failures=$((failures + 1))
  else
    log "check: self-test uninstall/rollback path OK (managed removal verified)"
  fi
  rm -rf "$tmp"

  if [ "$failures" -gt 0 ]; then
    die "check: $failures check(s) failed"
  fi
  log "check: ALL OK (workspace install remains the supported default; global form verified optional)"
}

# ---------------------------------------------------------------------------
# argument dispatch
# ---------------------------------------------------------------------------

SOURCE_FLAG=""
ACTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)    ACTION="check" ;;
    --uninstall) ACTION="uninstall" ;;
    --help|-h)  usage; exit 0 ;;
    --source)   [ $# -ge 2 ] || die "--source requires a directory argument"
                SOURCE_FLAG="$2"; shift ;;
    --source=*) SOURCE_FLAG="${1#--source=}"
                [ -n "$SOURCE_FLAG" ] || die "--source= requires a non-empty directory argument" ;;
    *)          die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$ACTION" in
  check)     cmd_check ;;
  uninstall) cmd_uninstall ;;
  install)   cmd_install ;;
  "")        cmd_install ;;
  *)         usage; exit 2 ;;
esac