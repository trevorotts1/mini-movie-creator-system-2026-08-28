#!/usr/bin/env bash
# project-install.sh — SKL-002: Claude Code / claude-nine PROJECT skill install for MMCS.
#
# Installs the canonical MMCS skill (skills/mini-movie-creator/, owned by SKL-001 —
# this wrapper NEVER edits it) into the project skill directory so a fresh `claude`
# or claude-nine session started in this repo discovers it:
#
#   .claude/skills/mini-movie-creator -> ../../skills/mini-movie-creator     (default: symlink)
#
# `--copy` fallback clones the canonical tree instead (filesystems without symlink
# support) and re-syncs it when the canonical source changes. A marker file
# (.claude/skills/.mini-movie-creator.copy-install) records copy-mode state.
#
# Guarantees:
#   - Idempotent: rerunning when the install is already correct changes nothing.
#   - Non-destructive: an existing real file/directory at the target is never
#     overwritten unless --force is given, and even then only after backing it
#     up to <target>.backup-<timestamp>/ in the same directory.
#   - --dry-run prints the actions it would take and mutates nothing.
#   - --check verifies the install; it does not install.
#
# Exit codes: 0 success / already installed; 1 error (missing canonical source,
# refused overwrite, failed check); 2 usage error.
#
# Usage:
#   bash integrations/claude/project-install.sh              # install (symlink mode)
#   bash integrations/claude/project-install.sh --copy       # install (copy + sync mode)
#   bash integrations/claude/project-install.sh --check      # verify install only
#   bash integrations/claude/project-install.sh --dry-run    # show what would happen
#   bash integrations/claude/project-install.sh --force      # allow replace of a
#                                                            # non-symlink target
#                                                            # (with backup first)
set -euo pipefail

MODE="install"   # install | check
FORCE=0
COPY=0
DRY=0

print_usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | grep -E '^#( |$)' | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE="check" ;;
    --dry-run) DRY=1 ;;
    --copy)    COPY=1 ;;
    --force)   FORCE=1 ;;
    --help|-h) print_usage ;;
    *) echo "ERROR: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ "$MODE" = "check" ] && [ "$FORCE" = "1" ]; then
  echo "ERROR: --force has no effect together with --check" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CANONICAL="$REPO_ROOT/skills/mini-movie-creator"
SKILLS_DIR="$REPO_ROOT/.claude/skills"
TARGET="$SKILLS_DIR/mini-movie-creator"
COPY_MARKER="$SKILLS_DIR/.mini-movie-creator.copy-install"
REL_TARGET="../../skills/mini-movie-creator"   # relative to .claude/skills/

log()  { echo "$*"; }
warn() { echo "WARN: $*" >&2; }
fail() { echo "ERROR: $*" >&2; exit 1; }
run()  { # prints what a dry run would do, else executes
  if [ "$DRY" = "1" ]; then log "DRY-RUN: $*"; else "$@"; fi
}

link_is_correct() {
  [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$REL_TARGET" ]
}

canonical_present() {
  [ -f "$CANONICAL/SKILL.md" ]
}

# ---- check mode -------------------------------------------------------------

check() {
  if link_is_correct; then
    if canonical_present; then
      log "OK: .claude/skills/mini-movie-creator -> $REL_TARGET (canonical source present, SKILL.md found)."
    else
      log "OK: .claude/skills/mini-movie-creator -> $REL_TARGET (symlink correct)."
      warn "canonical source skills/mini-movie-creator/ is not on this branch yet (SKL-001); the symlink resolves as soon as it lands."
    fi
    return 0
  fi
  if [ -f "$COPY_MARKER" ] && [ -d "$TARGET" ]; then
    copy_sync_needed
    if [ "$COPY_DIRTY" = "1" ]; then
      warn "copy-mode install is present but out of sync with the canonical source."
      return 1
    fi
    log "OK: copy-mode install present and in sync with skills/mini-movie-creator."
    return 0
  fi
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    warn "$TARGET exists but does not point at the canonical source ($REL_TARGET)."
    warn "Re-run without --check (optionally with --force) to repair."
  else
    warn "$TARGET does not exist. Run: bash integrations/claude/project-install.sh"
  fi
  return 1
}

# ---- copy mode helpers ------------------------------------------------------

# Emits "1" via the variable COPY_DIRTY if target needs (re)sync.
copy_sync_needed() {
  COPY_DIRTY=0
  if [ ! -d "$TARGET" ]; then COPY_DIRTY=1; return 0; fi
  local status_file
  status_file="$(mktemp)"
  (
    cd "$CANONICAL" || exit 1
    find . -type f ! -name '.*' -print
  ) | LC_ALL=C sort > "$status_file.files"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    if [ ! -f "$TARGET/$rel" ] || ! cmp -s "$CANONICAL/$rel" "$TARGET/$rel"; then
      echo "1" > "$status_file.dirty"
      break
    fi
  done < "$status_file.files"
  # stale files present in target that no longer exist in canonical?
  if [ ! -s "$status_file.dirty" ]; then
    (
      cd "$TARGET" || exit 1
      find . -type f ! -name '.*' -print
    ) | LC_ALL=C sort > "$status_file.tfiles"
    (
      cd "$CANONICAL" || exit 1
      find . -type f ! -name '.*' -print
    ) | LC_ALL=C sort > "$status_file.sfiles"
    if ! cmp -s "$status_file.tfiles" "$status_file.sfiles"; then
      echo "1" > "$status_file.dirty"
    fi
  fi
  if [ -s "$status_file.dirty" ]; then COPY_DIRTY=1; fi
  rm -f "$status_file" "$status_file.files" "$status_file.tfiles" "$status_file.sfiles" "$status_file.dirty"
  return 0
}

copy_sync() { # copies canonical -> target, one file at a time, skipping when identical
  local rel dir
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    rel="${rel#./}"
    dir="$(dirname "$TARGET/$rel")"
    if [ ! -f "$TARGET/$rel" ] || ! cmp -s "$CANONICAL/$rel" "$TARGET/$rel"; then
      run mkdir -p "$dir"
      run cp -p "$CANONICAL/$rel" "$TARGET/$rel"
      [ "$DRY" = "1" ] && log "DRY-RUN: would copy $CANONICAL/$rel -> $TARGET/$rel"
    fi
  done < <( cd "$CANONICAL" && find . -type f ! -name '.*' -print | LC_ALL=C sort )
  # remove files that disappeared from canonical (stale copies must not linger)
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    rel="${rel#./}"
    if [ ! -f "$CANONICAL/$rel" ]; then
      run rm -f "$TARGET/$rel"
      [ "$DRY" = "1" ] && log "DRY-RUN: would remove stale $TARGET/$rel"
    fi
  done < <( cd "$TARGET" && find . -type f ! -name '.*' -print | LC_ALL=C sort )
}

write_copy_marker() {
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would write $COPY_MARKER"
    return 0
  fi
  {
    echo '{'
    echo "  \"mode\": \"copy\","
    echo "  \"canonical\": \"skills/mini-movie-creator\","
    echo "  \"target\": \".claude/skills/mini-movie-creator\","
    echo "  \"installedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    echo '}'
  } > "$COPY_MARKER"
}

# ---- install mode -----------------------------------------------------------

install_symlink() {
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if link_is_correct; then
      log "OK: already installed (.claude/skills/mini-movie-creator -> $REL_TARGET). Nothing to do."
      return 0
    fi
    if [ -L "$TARGET" ]; then
      log "Repointing symlink $(readlink "$TARGET") -> $REL_TARGET"
      run rm "$TARGET"
      run ln -s "$REL_TARGET" "$TARGET"
      [ "$DRY" = "1" ] || log "OK: symlink repointed."
      return 0
    fi
    if [ "$FORCE" != "1" ]; then
      warn "$TARGET exists and is NOT a symlink to the canonical source."
      warn "Refusing to overwrite it. Re-run with --force to back it up to"
      warn "$TARGET.backup-<timestamp> and replace it with the symlink."
      exit 1
    fi
    backup_existing
    run rm -rf "$TARGET"
  fi
  run mkdir -p "$SKILLS_DIR"
  run ln -s "$REL_TARGET" "$TARGET"
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would create $TARGET -> $REL_TARGET"
  else
    log "OK: installed .claude/skills/mini-movie-creator -> $REL_TARGET"
  fi
  return 0
}

backup_existing() {
  local stamp backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$TARGET.backup-$stamp"
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: would back up $TARGET -> $backup"
  else
    cp -Rp "$TARGET" "$backup"
    log "OK: backed up previous $TARGET -> $backup"
  fi
}

install_copy() {
  if [ -L "$TARGET" ]; then
    if link_is_correct; then
      log "OK: symlink install already present and correct; nothing to copy."
      return 0
    fi
    warn "$TARGET is a symlink but points at $(readlink "$TARGET"), not $REL_TARGET."
    warn "Fixing the symlink is the --copy install's job only when it is broken; run without --copy to repoint, or use --force."
    exit 1
  fi
  if [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; then
    if [ "$FORCE" != "1" ]; then
      warn "$TARGET exists and is not a directory."
      warn "Re-run with --force to back it up and replace it."
      exit 1
    fi
    backup_existing
    run rm -f "$TARGET"
  fi
  if [ -d "$TARGET" ] && [ ! -f "$COPY_MARKER" ]; then
    # A real directory that a previous copy install did NOT create: never merge
    # into someone else's skill directory uninvited.
    if [ "$FORCE" != "1" ]; then
      warn "$TARGET is an existing real directory not created by this installer."
      warn "Refusing to merge the canonical skill into it. Re-run with --force to"
      warn "back it up and replace it with a fresh copy install."
      exit 1
    fi
    backup_existing
    run rm -rf "$TARGET"
  fi
  copy_sync
  write_copy_marker
  if [ "$DRY" = "1" ]; then
    log "DRY-RUN: copy-mode install of skills/mini-movie-creator -> $TARGET"
  else
    log "OK: copy-mode install synced skills/mini-movie-creator -> $TARGET"
  fi
  return 0
}

main() {
  if [ "$MODE" = "check" ]; then
    check
    exit $?
  fi
  # Install paths require the canonical source (SKL-001) to be present.
  if ! canonical_present; then
    echo "ERROR: canonical skill source not found at skills/mini-movie-creator/SKILL.md." >&2
    echo "This wrapper installs FROM the canonical source (owned by SKL-001) and never edits it." >&2
    echo "Ensure SKL-001 has landed on this branch, then re-run." >&2
    exit 1
  fi
  if [ "$COPY" = "1" ]; then
    install_copy
  else
    install_symlink
  fi
  exit $?
}

main