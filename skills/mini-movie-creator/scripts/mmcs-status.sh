#!/usr/bin/env bash
# mmcs-status.sh — portable MMCS engine-surface probe (skills/mini-movie-creator).
#
# Purpose (spec §27): let any host (Claude Code, claude-nine, OpenClaw, CI,
# hooks) verify the MMCS engine surface is reachable WITHOUT mutating state,
# touching the network, or spending money. Prints a short report to stdout;
# exits 0 when the engine surface is present, 1 when it is not.
#
# Behavior contract:
# - Locates the repo root from the script location (or $MMCS_REPO_ROOT).
# - Checks: CLI source present, CLI build artifact (or buildable), command
#   registry present, stub state files present.
# - NEVER reads or prints secret values; never runs `mmcs` mutating verbs.
# - Read-only by design: `mmcs status` is invoked only if a built CLI exists,
#   and failures there are reported as WARN, never fatal (stub CLI exits 0).

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Repo root: script lives at <root>/skills/mini-movie-creator/scripts/ —
# walk up from SKILL_DIR until a directory containing apps/cli is found.
# Allow an explicit override for non-standard installs (OpenClaw packaging).
REPO_ROOT="${MMCS_REPO_ROOT:-}"
if [ -z "$REPO_ROOT" ]; then
  probe="$(dirname "$SKILL_DIR")"   # skills/ (or the skill's parent when copied)
  while [ "$probe" != "/" ]; do
    if [ -d "$probe/apps/cli" ]; then REPO_ROOT="$probe"; break; fi
    probe="$(dirname "$probe")"
  done
fi
# Fallback: CWD when it looks like the monorepo root (has apps/cli).
if [ -z "$REPO_ROOT" ] && [ -d "$PWD/apps/cli" ]; then
  REPO_ROOT="$PWD"
fi

# Hard stop when the root is still unknown: every check below is anchored to
# REPO_ROOT, and guessing would produce false FAILs against the CWD.
if [ -z "$REPO_ROOT" ]; then
  say "repo root: <unresolved> — walk-up, \$MMCS_REPO_ROOT, and \$PWD all failed"
  say "engine surface INCOMPLETE — exit 1 (no mutation performed)"
  exit 1
fi

fail=0
say() { printf '[mmcs-status] %s\n' "$1"; }
ok()  { say "OK   $1"; }
warn() { say "WARN $1"; }
bad() { say "FAIL $1"; fail=1; }

say "repo root: $REPO_ROOT"

# 1. CLI surface present?
if [ -f "$REPO_ROOT/apps/cli/src/index.ts" ]; then
  ok "cli source: apps/cli/src/index.ts"
else
  bad "cli source missing: $REPO_ROOT/apps/cli/src/index.ts"
fi

if [ -f "$REPO_ROOT/apps/cli/src/dispatch/registry.ts" ]; then
  ok "command registry: apps/cli/src/dispatch/registry.ts"
else
  bad "command registry missing: apps/cli/src/dispatch/registry.ts"
fi

# 2. CLI built? (dist artifact optional — source is enough for WARN-level)
if [ -f "$REPO_ROOT/apps/cli/dist/index.js" ]; then
  ok "cli build artifact: apps/cli/dist/index.js"
else
  warn "cli not built (run: pnpm --filter @mmcs/cli build) — verbs run via node apps/cli/dist/index.js after build"
fi

# 3. Stub state files present? (checkpoint + task store are the durable pair)
if [ -f "$REPO_ROOT/state/checkpoint.json" ]; then
  ok "checkpoint state: state/checkpoint.json"
else
  bad "checkpoint state missing: state/checkpoint.json"
fi

if [ -f "$REPO_ROOT/state/tasks.json" ]; then
  ok "task store: state/tasks.json"
else
  warn "task store missing: state/tasks.json (fresh checkout before planning may be fine)"
fi

# 4. Skill files self-check (this skill is the canonical source).
for f in SKILL.md references/workflow.md references/approvals.md \
         references/providers.md references/recovery.md scripts/mmcs-status.sh; do
  if [ -f "$SKILL_DIR/$f" ]; then
    ok "skill file: $f"
  else
    bad "skill file missing: $f"
  fi
done

# 5. Read-only engine probe — only when a built CLI exists. Never fatal:
#    the stub CLI may not be built in this checkout, and `mmcs status` on a
#    stub registry still exits 0. Any failure here is WARN.
if [ -f "$REPO_ROOT/apps/cli/dist/index.js" ]; then
  if "$REPO_ROOT/apps/cli/dist/index.js" status >/dev/null 2>&1; then
    ok "engine probe: mmcs status exited 0"
  else
    warn "engine probe: mmcs status non-zero (stub registry or partial build) — not fatal for this probe"
  fi
fi

# 6. Never print secrets: this script reads no .env and no credential file.
#    (Documented invariant; nothing here globs environment or env files.)

if [ "$fail" -eq 0 ]; then
  say "engine surface reachable — exit 0"
else
  say "engine surface INCOMPLETE — exit 1 (no mutation performed)"
fi
exit "$fail"