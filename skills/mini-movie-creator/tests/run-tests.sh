#!/usr/bin/env bash
# run-tests.sh — acceptance tests for skills/mini-movie-creator (spec §27, SKL-001).
#
# Verifies the skill's own acceptance criteria:
#   1. SKILL.md present with AgentSkills-style frontmatter, <= 500 lines.
#   2. All 25 required behaviors of spec §27 are teachable from SKILL.md
#      (each behavior has a discoverable anchor: section, verb, or rule text).
#   3. Reference files hold detail (each >= 60 lines, non-trivial).
#   4. No secrets / hard-coded credentials anywhere in the skill
#      (secret-scan grep clean).
#   5. `bash skills/mini-movie-creator/scripts/mmcs-status.sh` exits 0
#      against a stub state.
#
# Exit 0 = all pass. Exit 1 = at least one failure (listed). Read-only.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
# Walk up from the skill's parent until a directory containing apps/cli is
# found (the monorepo root). Falls back to MMCS_REPO_ROOT / CWD override.
REPO_ROOT="${MMCS_REPO_ROOT:-}"
if [ -z "$REPO_ROOT" ]; then
  probe="$(dirname "$SKILL_DIR")"
  while [ "$probe" != "/" ]; do
    if [ -d "$probe/apps/cli" ]; then REPO_ROOT="$probe"; break; fi
    probe="$(dirname "$probe")"
  done
fi

pass=0
fail=0
failures=()

check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    failures+=("$label")
    printf 'FAIL  %s\n' "$label"
  fi
}

# --- 1. SKILL.md structure ---
check "SKILL.md exists" test -f "$SKILL_DIR/SKILL.md"
lines=$(wc -l < "$SKILL_DIR/SKILL.md" | tr -d ' ')
if [ "$lines" -le 500 ]; then pass=$((pass+1)); else
  fail=$((fail+1)); failures+=("SKILL.md has $lines lines (> 500)")
  printf 'FAIL  SKILL.md has %s lines (> 500)\n' "$lines"
fi
check "SKILL.md starts with --- frontmatter" test "$(head -1 "$SKILL_DIR/SKILL.md")" = "---"
check "frontmatter has name: mini-movie-creator" \
  sh -c "head -20 '$SKILL_DIR/SKILL.md' | grep -q '^name: mini-movie-creator$'"
check "frontmatter has description:" \
  sh -c "head -20 '$SKILL_DIR/SKILL.md' | grep -q '^description:'"
check "name/description block closes with --- before body" \
  sh -c "sed -n '3,30p' '$SKILL_DIR/SKILL.md' | grep -q '^---$'"

# --- 2. The 25 required behaviors (spec §27), each teachable from SKILL.md ---
S="$SKILL_DIR/SKILL.md"
declare -a behaviors=(
  "locate the engine/CLI|apps/cli"                                   # 1
  "run mmcs status before mutating|mmcs status"                      # 2
  "create/open series or standalone|create-series"                   # 3
  "collect idea + aspect ratio/runtime once|16:9"                    # 4
  "develop concept + STOP|develop-concept"                           # 5
  "write script + STOP|write-script"                                 # 6
  "resolve cast from Character Library|Character Library"            # 7
  "3 candidates per new character|exactly 3"                         # 8
  "choice 1/2/3/Try Again|Try Again"                                 # 9
  "lock only after approval|approve-character"                       # 10
  "persist GHL file ID/URL/checksum/character ID|checksum"           # 11
  "plan scenes/shots|ShotPlanner"                                    # 12
  "0/1/2 keyframes or multimodal reference per shot|keyframes or multimodal" # 13
  "validate prompt-char + reference limits|capability registry"      # 14
  "storyboard STOP|approve-storyboard"                               # 15
  "estimate provider usage/cost|mmcs estimate"                       # 16
  "auto-authorize below \$25|strictly below [\$]25"                  # 17
  "require approval at \$25 or above|[\$]25.00 or above"             # 18
  "generate voices/media|mmcs generate"                              # 19
  "archive outputs into GHL immediately|Immediately archive|immediately archive" # 20
  "QC/continuity checks|mmcs qc"                                     # 21
  "rough cut STOP|rough-cut"                                         # 22
  "revise only affected shots|retry-shot"                            # 23
  "render final|mmcs final"                                          # 24
  "canon proposals require approval|canon review"                    # 25
)
i=0
for entry in "${behaviors[@]}"; do
  i=$((i+1))
  label="${entry%%|*}"
  pattern="${entry#*|}"
  # Pattern passed via env so $ and | survive shell quoting.
  check "behavior $i teachable: $label" \
    env MMCS_GREP_PAT="$pattern" MMCS_SKILL_MD="$S" sh -c 'grep -qE "$MMCS_GREP_PAT" "$MMCS_SKILL_MD"'
done

# --- 3. References hold detail ---
for ref in workflow approvals providers recovery; do
  f="$SKILL_DIR/references/$ref.md"
  check "reference exists: $ref.md" test -f "$f"
  n=$( [ -f "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0 )
  if [ "$n" -ge 60 ]; then pass=$((pass+1)); else
    fail=$((fail+1)); failures+=("references/$ref.md only $n lines (< 60)")
    printf 'FAIL  references/%s.md only %s lines (< 60)\n' "$ref" "$n"
  fi
done

# --- 4. Secret scan (grep clean) ---
# Names of env variables are allowed (they are documentation); VALUES are not.
secret_hit=$(grep -rInE \
  '(api[_-]?key|apikey|token|secret|password|bearer)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_\-]{16,}' \
  "$SKILL_DIR" 2>/dev/null | grep -v "run-tests.sh" | grep -v "NAMES + descriptions" || true)
if [ -z "$secret_hit" ]; then pass=$((pass+1)); else
  fail=$((fail+1)); failures+=("secret-pattern hit: $secret_hit")
  printf 'FAIL  secret-pattern hit:\n%s\n' "$secret_hit"
fi
# No concrete-looking credential values (long random strings), no sk-/ghp_ style tokens.
check "no hardcoded token shapes (sk-, ghp_, AKIA, xox)" \
  sh -c "! grep -rInE '(sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{30}|AKIA[0-9A-Z]{16}|xox[baprs]-)' '$SKILL_DIR'"
check "no real http URLs with embedded credentials" \
  sh -c "! grep -rInE 'https?://[^/[:space:]]+:[^@/[:space:]]+@' '$SKILL_DIR'"

# --- 5. mmcs-status.sh exits 0 against stub state ---
out=$(MMCS_REPO_ROOT="$REPO_ROOT" bash "$SKILL_DIR/scripts/mmcs-status.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then pass=$((pass+1)); else
  fail=$((fail+1)); failures+=("mmcs-status.sh exited $rc: $out")
  printf 'FAIL  mmcs-status.sh exited %s\n%s\n' "$rc" "$out"
fi
# status script must be executable + bash-clean
check "mmcs-status.sh is executable" test -x "$SKILL_DIR/scripts/mmcs-status.sh"
check "mmcs-status.sh bash -n syntax clean" bash -n "$SKILL_DIR/scripts/mmcs-status.sh"
check "run-tests.sh bash -n syntax clean" bash -n "$SCRIPT_DIR/run-tests.sh"

# --- 6. Regression tests (QC fixes) ---
# 6a. Build instruction must match the pnpm monorepo (never `npm run build`).
check "SKILL.md uses pnpm build command (not npm)" \
  sh -c "! grep -q 'npm run build' '$SKILL_DIR/SKILL.md'"
# 6b. workflow.md must not contain the self-contradictory verb typo
#     (`mmcs approve concept`, not `mmcs approve concept`).
check "workflow.md verb typo fixed" \
  sh -c "! grep -q 'not \`mmcs approve concept\`' '$SKILL_DIR/references/workflow.md'"
# 6c. mmcs-status.sh must exit 1 (never a false PASS) when the repo root is
#     unresolvable: walk-up from a sandbox copy finds no apps/cli ancestor.
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/skills/mini-movie-creator/scripts"
cp "$SKILL_DIR/scripts/mmcs-status.sh" "$sandbox/skills/mini-movie-creator/scripts/"
if ( cd "$sandbox" && MMCS_REPO_ROOT= bash "$sandbox/skills/mini-movie-creator/scripts/mmcs-status.sh" >/dev/null 2>&1 ); then
  fail=$((fail+1)); failures+=("mmcs-status.sh unresolved root exits 1")
  printf 'FAIL  mmcs-status.sh unresolved root exits 1\n'
else
  pass=$((pass+1))
fi
rm -rf "$sandbox"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf 'Failures:\n'
  for f in "${failures[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0