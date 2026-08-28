#!/usr/bin/env bash
# personal-install.sh — SKL-003: Claude Code / claude-nine PERSONAL skill install for MMCS.
#
# Installs the canonical MMCS skill (skills/mini-movie-creator/, owned by SKL-001 —
# this wrapper NEVER edits it) into the user's personal skill directory so an
# ordinary `claude` or claude-nine session started OUTSIDE the repo also discovers it:
#
#   $HOME/.claude/skills/mini-movie-creator -> <canonical source>   (absolute symlink)
#
# The canonical source default is <this repo>/skills/mini-movie-creator (resolved
# relative to this script), overridable with --source <path> for a checkout
# elsewhere.
#
# SAFETY — the personal scope is the operator's working environment, so this
# wrapper is deliberately the strictest of the three install targets:
#
#   - An existing personal skill is NEVER destroyed without BOTH --force and
#     --confirm (typed confirmation). Before replacing anything, the installer
#     writes a full backup to <target>.backup-<timestamp>/ in the same directory.
#     Spec §27: "Never overwrite an existing personal skill without
#     backup/confirmation."
#   - A wrong SYMLINK is repointed without backup (a link holds no skill content;
#     nothing is destroyed).
#   - --dry-run prints every action and mutates nothing.
#   - --check verifies only; it never installs, never backs up, never touches $HOME.
#
# Discovery-root note (spec §27 install target 2): plain `claude` discovers
# personal skills in ~/.claude/skills/; `claude-nine` uses ~/.claude-nine/skills/
# as its PRIMARY personal root and syncs new skills from ~/.claude/skills/ via
# ~/.local/bin/sync-nine-skills.sh at every launch (claude-nine's own real
# directories win over symlinks). Installing here therefore makes the skill
# visible to claude-nine on its next launch through that sync — see
# PERSONAL-INSTALL.md for the exact discovery-root documentation and verification.
#
# Exit codes: 0 success / already installed / check-passed; 1 error (missing
# canonical source, refused overwrite, broken symlink, failed check); 2 usage error.
#
# Usage:
#   bash integrations/claude/personal-install.sh                   # install (symlink)
#   bash integrations/claude/personal-install.sh --source <path>   # canonical content from another checkout
#   bash integrations/claude/personal-install.sh --repo-root <path> # engine/repo root recorded in ~/.mmcs/mmcs.env
#   bash integrations/claude/personal-install.sh --check           # verify install only
#   bash integrations/claude/personal-install.sh --dry-run         # show what would happen
#   bash integrations/claude/personal-install.sh --force --confirm # replace an existing
#                                                                 # personal skill (full
#                                                                 # backup first; --confirm
#                                                                 # is the typed confirmation)
set -euo pipefail

MODE="install"   # install | check
FORCE=0
CONFIRM=0
DRY=0
SOURCE=""
REPO_ROOT_OVERRIDE=""

print_usage() {
  # print the whole header comment (everything until the `set -euo pipefail` line),
  # stripping the leading '# ' — no fragile line-number range that drifts when the
  # header is edited.
  awk 'NR < 2 { next } $0 == "set -euo pipefail" { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE="check" ;;
    --dry-run) DRY=1 ;;
    --force)   FORCE=1 ;;
    --confirm) CONFIRM=1 ;;
    --source)  shift; [ $# -gt 0 ] || { echo "ERROR: --source requires a path" >&2; exit 2; }; SOURCE="$1" ;;
    --repo-root) shift; [ $# -gt 0 ] || { echo "ERROR: --repo-root requires a path" >&2; exit 2; }; REPO_ROOT_OVERRIDE="$1" ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ "$MODE" = "check" ] && { [ "$FORCE" = "1" ] || [ "$CONFIRM" = "1" ] || [ "$DRY" = "1" ] || [ -n "$REPO_ROOT_OVERRIDE" ] || [ -n "$SOURCE" ]; }; then
  echo "ERROR: --force/--confirm/--dry-run/--source/--repo-root have no effect together with --check" >&2
  exit 2
fi
if [ "$CONFIRM" = "1" ] && [ "$FORCE" != "1" ]; then
  echo "ERROR: --confirm only makes sense together with --force" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "$REPO_ROOT_OVERRIDE" ]; then
  REPO_ROOT="$(cd "$REPO_ROOT_OVERRIDE" && pwd)" 2>/dev/null || { echo "ERROR: --repo-root path does not exist: $REPO_ROOT_OVERRIDE" >&2; exit 1; }
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

TARGET="$HOME/.claude/skills/mini-movie-creator"
SKILLS_DIR="$HOME/.claude/skills"
ENV_DIR="$HOME/.mmcs"
ENV_FILE="$ENV_DIR/mmcs.env"
if [ -n "$SOURCE" ]; then
  CANONICAL="$(cd "$SOURCE" && pwd)" 2>/dev/null || { echo "ERROR: --source path does not exist: $SOURCE" >&2; exit 1; }
else
  CANONICAL="$REPO_ROOT/skills/mini-movie-creator"
fi

log()  { echo "$*"; }
warn() { echo "WARN: $*" >&2; }
run()  { # prints what a dry run would do, else executes
  if [ "$DRY" = "1" ]; then log "DRY-RUN: $*"; else "$@"; fi
}

canonical_present() {
  [ -f "$CANONICAL/SKILL.md" ]
}

link_is_correct() {
  [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$CANONICAL" ]
}

# ---- check mode -------------------------------------------------------------

check() {
  if link_is_correct; then
    if canonical_present; then
      log "OK: $HOME/.claude/skills/mini-movie-creator -> $CANONICAL (canonical source present, SKILL.md found)."
    else
      log "OK: $HOME/.claude/skills/mini-movie-creator -> $CANONICAL (symlink correct)."
      warn "canonical source $CANONICAL has no SKILL.md yet (SKL-001 not merged); the symlink resolves as soon as it lands."
    fi
    return 0
  fi
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    warn "$TARGET exists but does not point at $CANONICAL."
    warn "Re-run without --check (optionally with --force --confirm) to repair."
  else
    warn "$TARGET does not exist. Run: bash integrations/claude/personal-install.sh"
  fi
  return 1
}

# ---- personal-scope environment file ----------------------------------------
# A personal-scope `claude`/claude-nine session started OUTSIDE the repo cannot
# self-locate the engine by walk-up (the mmcs-status.sh walk-up is
# lexical-dirname through the symlink and stops at $HOME). The canonical
# skill's own escape hatch is $MMCS_REPO_ROOT (documented in
# skills/mini-movie-creator/scripts/mmcs-status.sh; owned by SKL-001 — names
# only, never edited here). This installer therefore records the repo root in
# $HOME/.mmcs/mmcs.env so a personal-scope agent can source it and converge on
# the same engine: `source ~/.mmcs/mmcs.env && bash
# ~/.claude/skills/mini-movie-creator/scripts/mmcs-status.sh`. No secret
# values ever: env NAMES only, plus the repo root path.

write_env() {
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would write $ENV_FILE (MMCS_REPO_ROOT=$REPO_ROOT MMCS_CLI=$REPO_ROOT/apps/cli/dist/index.js)"
    return 0
  fi
  run mkdir -p "$ENV_DIR"
  {
    echo "# MMCS personal-scope engine location (written by integrations/claude/personal-install.sh, SKL-003)."
    echo "# Source this in a session started OUTSIDE the repo:  source \"\$HOME/.mmcs/mmcs.env\""
    echo "# No secret values here — paths and env variable names only."
    echo "export MMCS_REPO_ROOT=\"$REPO_ROOT\""
    echo "export MMCS_CLI=\"$REPO_ROOT/apps/cli/dist/index.js\""
    echo "export MMCS_SKILL_SOURCE=\"$CANONICAL\""
  } > "$ENV_FILE"
  log "OK: wrote $ENV_FILE"
  # The installed skill reached the operator's $HOME; the engine root recorded
  # is the durable checkout (--repo-root) even when --source was a worktree.
}

# ---- backup -----------------------------------------------------------------

backup_existing() {
  local stamp backup i
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$TARGET.backup-$stamp"
  i=1
  # Two forced replaces within the same second must never share a backup dir
  # name: cp -R into an existing dir would nest the second copy inside the
  # first backup and silently overwrite its files. Suffix -2, -3, ... instead.
  while [ -e "$backup" ] || [ -L "$backup" ]; do
    i=$((i + 1))
    backup="$TARGET.backup-$stamp-$i"
  done
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would back up $TARGET -> $backup"
  else
    # -P: preserve symlinks inside the backup as links (never dereference):
    # the replaced tree is restored exactly, and a link into a big tree
    # (e.g. node_modules) cannot balloon or recurse the copy.
    cp -RPp "$TARGET" "$backup"
    log "OK: backed up previous $TARGET -> $backup"
  fi
}

# ---- install ----------------------------------------------------------------

install() {
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if link_is_correct; then
      log "OK: already installed ($TARGET -> $CANONICAL). Nothing to do."
      write_env
      return 0
    fi
    if [ -L "$TARGET" ]; then
      # wrong symlink: repoint is not destruction of a skill (a link holds no content)
      log "Repointing symlink $(readlink "$TARGET") -> $CANONICAL"
      run rm "$TARGET"
      run ln -s "$CANONICAL" "$TARGET"
      write_env
      [ "$DRY" = "1" ] || log "OK: symlink repointed."
      return 0
    fi
    if [ "$FORCE" != "1" ]; then
      warn "$TARGET exists and is NOT a symlink to the canonical source."
      warn "Refusing to touch it. Re-run with --force --confirm (typed confirmation) to"
      warn "back it up to $TARGET.backup-<timestamp> and replace it with the symlink."
      exit 1
    fi
    if [ "$CONFIRM" != "1" ]; then
      warn "$TARGET exists and is NOT a symlink to the canonical source."
      warn "Refusing to overwrite WITHOUT typed confirmation. Re-run with --force --confirm"
      warn "to back it up to $TARGET.backup-<timestamp> and replace it with the symlink."
      exit 1
    fi
    # existing real file/dir + --force --confirm: back up, then replace
    backup_existing
    run rm -rf "$TARGET"
  fi
  run mkdir -p "$SKILLS_DIR"
  run ln -s "$CANONICAL" "$TARGET"
  write_env
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would create $TARGET -> $CANONICAL"
  else
    log "OK: installed personal skill $TARGET -> $CANONICAL"
  fi
  return 0
}

main() {
  if [ "$MODE" = "check" ]; then
    check
    exit $?
  fi
  if ! canonical_present; then
    echo "ERROR: canonical skill source not found at $CANONICAL/SKILL.md." >&2
    echo "This wrapper installs FROM the canonical source (owned by SKL-001) and never edits it." >&2
    echo "Ensure SKL-001 has landed at that location, or pass --source <path>." >&2
    exit 1
  fi
  install
  exit $?
}

main
