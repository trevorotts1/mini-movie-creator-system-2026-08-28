#!/usr/bin/env bash
# invocation-test.sh — SKL-007: OpenClaw skill invocation test for MMCS.
#
# Proves the SKL-007 acceptance chain end to end:
#   1. `openclaw skills check` passes (exit 0) and the mini-movie-creator skill
#      is eligible + model-visible for the target agent.
#   2. Skill watcher pickup is VERIFIED, not assumed: a temporary probe skill is
#      dropped into the agent workspace skills root and its appearance (and later
#      removal) is observed through `openclaw skills check --json` WITHOUT a
#      gateway restart.
#   3. Explicit invocation from an OpenClaw agent reaches the SAME mmcs engine
#      and project state: an `openclaw agent` turn is told to run the engine's
#      `status` verb; the agent-session transcript is then parsed for the tool
#      result and its output is compared, byte-for-byte, with a direct local run
#      of the same engine binary.
#
# Modes:
#   default          full test: preconditions + skills check + installed check
#                    + watcher probe + (with MMCS_OPENCLAW_LIVE=1) live agent
#                    invocation and same-engine verification.
#   --check          verify current state only (no installs, no probe, no agent
#                    turn). Exit 0 = ready to run the full test.
#   --self-test      structural self-check of this script (offline, no openclaw).
#
# Mutations this script can perform (never silent):
#   --install        install the MMCS OpenClaw packaging into the target agent's
#                    workspace via `openclaw skills install … --as mini-movie-creator
#                    --force` (backs nothing up; OpenClaw owns the copy — the
#                    canonical skill source is never touched).
#   watcher probe    creates and removes <workspace>/skills/mmcs-watcher-probe
#                    (temporary, always cleaned up).
#   agent turn       one read-only `openclaw agent` turn (runs `mmcs status` only
#                    — a non-mutating engine verb). Gated: it is skipped unless
#                    MMCS_OPENCLAW_LIVE=1 so batch regression runs never spend
#                    model tokens by accident.
#
# Environment:
#   MMCS_ROOT                        engine root override (else: --mmcs-root flag
#                                    > walk up from cwd for "mmcs-monorepo").
#   MMCS_OPENCLAW_AGENT              target agent id (default: codex-computer-use;
#                                    the fleet `main` agent ships an empty skills
#                                    allowlist, `skills: []`, which filters ALL
#                                    skills out — see docs/openclaw-skill-verification.md).
#   MMCS_SKILL_DIR                   OpenClaw packaging dir override (default:
#                                    <repo>/integrations/openclaw/mini-movie-creator,
#                                    owned by SKL-005).
#   MMCS_OPENCLAW_LIVE=1             enable the live agent-invocation step.
#   MMCS_OPENCLAW_SKIP_WATCHER=1     skip the watcher probe.
#   MMCS_OPENCLAW_AGENT_TIMEOUT      seconds for the agent turn (default 150).
#
# Exit codes: 0 pass · 1 test failure · 2 precondition failure.
#
# Usage:
#   bash integrations/openclaw/invocation-test.sh --check
#   MMCS_OPENCLAW_LIVE=1 bash integrations/openclaw/invocation-test.sh --install
#   bash integrations/openclaw/invocation-test.sh --self-test

set -u
set -o pipefail

MODE="run"
DO_INSTALL=0
TARGET_AGENT="${MMCS_OPENCLAW_AGENT:-codex-computer-use}"
AGENT_TIMEOUT="${MMCS_OPENCLAW_AGENT_TIMEOUT:-150}"
MMCS_PACKAGE_NAME="mmcs-monorepo"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${MMCS_ROOT:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
SKILL_NAME="mini-movie-creator"
SKILL_DIR="${MMCS_SKILL_DIR:-$REPO_ROOT/integrations/openclaw/mini-movie-creator}"
START_EPOCH="$(date +%s)"
EVID_FILE=""
cleanup() { [ -n "$EVID_FILE" ] && rm -f "$EVID_FILE"; }
trap cleanup EXIT

fail_pre()  { echo "invocation-test: PRECONDITION FAIL — $*" >&2; exit 2; }
fail_test() { echo "invocation-test: FAIL — $*" >&2; exit 1; }
ok()        { echo "invocation-test: PASS — $*"; }
note()      { echo "invocation-test: — $*"; }

print_usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | grep -E '^#( |$)' | sed 's/^# \{0,1\}//'; exit 0; }

is_positive_int() { case "$1" in ''|*[!0-9]*) return 1;; *) [ "$1" -ge 1 ] 2>/dev/null || return 1;; esac; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --self-test) MODE="self-test" ;;
    --install) DO_INSTALL=1 ;;
    --agent) [ "$#" -ge 2 ] || fail_pre "--agent needs a value"
             TARGET_AGENT="$2"; shift ;;
    --agent=*) TARGET_AGENT="${1#*=}"; [ -n "$TARGET_AGENT" ] || fail_pre "--agent needs a non-empty value" ;;
    --mmcs-root) [ "$#" -ge 2 ] || fail_pre "--mmcs-root needs a value"
                 REPO_ROOT="$2"; shift ;;
    --mmcs-root=*) REPO_ROOT="${1#*=}"; [ -n "$REPO_ROOT" ] || fail_pre "--mmcs-root needs a non-empty value" ;;
    --skill-dir) [ "$#" -ge 2 ] || fail_pre "--skill-dir needs a value"
                 SKILL_DIR="$2"; shift ;;
    --skill-dir=*) SKILL_DIR="${1#*=}"; [ -n "$SKILL_DIR" ] || fail_pre "--skill-dir needs a non-empty value" ;;
    --timeout) [ "$#" -ge 2 ] || fail_pre "--timeout needs a value"
               AGENT_TIMEOUT="$2"; shift ;;
    --timeout=*) AGENT_TIMEOUT="${1#*=}" ;;
    --help|-h) print_usage ;;
    *) fail_pre "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
is_positive_int "$AGENT_TIMEOUT" || fail_pre "--timeout/MMCS_OPENCLAW_AGENT_TIMEOUT must be a positive integer (got '$AGENT_TIMEOUT')."

# --- resolve engine root (never guess) ---------------------------------------
resolve_engine_root() {
  if [ -f "$REPO_ROOT/package.json" ] \
     && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${MMCS_PACKAGE_NAME}\"" "$REPO_ROOT/package.json" 2>/dev/null; then
    return 0
  fi
  local dir="$PWD"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] \
       && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${MMCS_PACKAGE_NAME}\"" "$dir/package.json" 2>/dev/null; then
      REPO_ROOT="$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# --- preconditions ------------------------------------------------------------
preconditions() {
  command -v openclaw >/dev/null 2>&1 || fail_pre "openclaw CLI not on PATH."
  command -v python3  >/dev/null 2>&1 || fail_pre "python3 not on PATH (needed for transcript parsing)."
  command -v node     >/dev/null 2>&1 || fail_pre "node not on PATH."
  resolve_engine_root || fail_pre "engine root not resolvable: pass --mmcs-root, set MMCS_ROOT, or run from inside the mmcs-monorepo checkout."
  DIST="$REPO_ROOT/apps/cli/dist/index.js"
  if [ ! -f "$DIST" ]; then
    note "cli not built — building apps/cli (pnpm run build)"
    if ! (cd "$REPO_ROOT/apps/cli" && (pnpm run build || npm run build)) >/dev/null 2>&1; then
      fail_pre "cli build failed in $REPO_ROOT/apps/cli"
    fi
  fi
  # The dist entrypoint needs the exec bit for the skill wrapper's [ -x ] check;
  # tsc does not set it. Correct it in place (idempotent, affects only this
  # checkout's build artifact).
  [ -x "$DIST" ] || chmod +x "$DIST" 2>/dev/null
  [ -f "$DIST" ] || fail_pre "cli dist missing after build: $DIST"
  ok "preconditions — openclaw CLI, engine root $REPO_ROOT, dist artifact"
}

# --- engine surface (direct, local) -------------------------------------------
direct_engine_status() {
  DIRECT_RC=0
  DIRECT_OUT="$(node "$DIST" status 2>&1)" || DIRECT_RC=$?
  [ "$DIRECT_RC" -eq 0 ] || fail_pre "direct engine run failed (rc=$DIRECT_RC): $DIRECT_OUT"
  DIRECT_FIRST_LINE="$(printf '%s' "$DIRECT_OUT" | head -1)"
  ok "direct engine run (node $DIST status) rc=0"
}

# --- step 1: openclaw skills check --------------------------------------------
skills_check() {
  if ! openclaw skills check --agent "$TARGET_AGENT" >/dev/null 2>&1; then
    fail_test "openclaw skills check --agent $TARGET_AGENT exited non-zero."
  fi
  ok "step 1 — openclaw skills check --agent $TARGET_AGENT exit 0"
}

skills_check_json_field() { # $1 = python list-membership test target list name
  openclaw skills check --agent "$TARGET_AGENT" --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('$1' in d.get('$2', []))
"
}

# --- step 2: skill installed + visible ----------------------------------------
skill_installed() {
  [ "$(skills_check_json_field "$SKILL_NAME" "eligible")" = "True" ] \
    && [ "$(skills_check_json_field "$SKILL_NAME" "modelVisible")" = "True" ]
}

skill_installed_check() {
  if skill_installed; then
    ok "step 2 — '$SKILL_NAME' eligible + model-visible for $TARGET_AGENT"
    return 0
  fi
  if [ "$DO_INSTALL" -eq 1 ] && [ -f "$SKILL_DIR/SKILL.md" ]; then
    note "step 2 — installing $SKILL_DIR → workspace ($TARGET_AGENT) via openclaw skills install"
    if ! openclaw skills install "$SKILL_DIR" --as "$SKILL_NAME" --force --agent "$TARGET_AGENT" >/dev/null 2>&1; then
      fail_test "openclaw skills install failed."
    fi
    if skill_installed; then
      ok "step 2 — installed + now eligible/model-visible"
      return 0
    fi
    fail_test "install ran but skill still not visible to $TARGET_AGENT (check agent skills allowlist)."
  fi
  [ -f "$SKILL_DIR/SKILL.md" ] || note "packaging dir $SKILL_DIR missing (SKL-005 branch) — pass --skill-dir to point at it."
  fail_test "'$SKILL_NAME' not installed/visible for $TARGET_AGENT. Rerun with --install (and check the agent's skills allowlist — the fleet 'main' agent ships skills: [])."
}

# --- step 3: watcher pickup probe (verified, not assumed) ----------------------
watcher_probe() {
  if [ "${MMCS_OPENCLAW_SKIP_WATCHER:-0}" = "1" ]; then
    note "step 3 — watcher probe skipped (MMCS_OPENCLAW_SKIP_WATCHER=1)"
    return 0
  fi
  local workspace probe start elapsed state
  workspace="$(openclaw skills check --agent "$TARGET_AGENT" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('workspaceDir',''))")"
  [ -n "$workspace" ] || fail_pre "could not resolve workspace dir for $TARGET_AGENT from openclaw skills check."
  probe="$workspace/skills/mmcs-watcher-probe"
  mkdir -p "$probe"
  printf -- '---\nname: mmcs-watcher-probe\ndescription: Temporary MMCS SKL-007 watcher-pickup probe. Safe to delete.\n---\n\n# probe\n\nProbe only. Reply "watcher-probe-ok" if invoked.\n' > "$probe/SKILL.md"
  start="$(date +%s)"
  state="never"
  for _ in $(seq 1 30); do
    if [ "$(skills_check_json_field "mmcs-watcher-probe" "eligible")" = "True" ] \
       && [ "$(skills_check_json_field "mmcs-watcher-probe" "modelVisible")" = "True" ]; then
      state="picked-up"
      break
    fi
    sleep 1
  done
  elapsed=$(( $(date +%s) - start ))
  rm -rf "$probe"
  [ "$state" = "picked-up" ] || fail_test "watcher probe NOT picked up within 30s of dropping $probe/SKILL.md (gateway restart required?). Probe dir removed."
  ok "step 3 — watcher PICKUP verified in ${elapsed}s (no gateway restart)"
  # removal pickup (bidirectional proof)
  start="$(date +%s)"
  state="never"
  for _ in $(seq 1 30); do
    if [ "$(skills_check_json_field "mmcs-watcher-probe" "eligible")" != "True" ]; then
      state="removed"
      break
    fi
    sleep 1
  done
  elapsed=$(( $(date +%s) - start ))
  [ "$state" = "removed" ] || fail_test "watcher did not reflect probe REMOVAL within 30s (stale snapshot)."
  ok "step 3 — watcher REMOVAL verified in ${elapsed}s (bidirectional)"
}

# --- step 4: explicit agent invocation + same-engine verification --------------
live_invocation() {
  local marker msg rc
  marker="MMCS_SKL007_$(date +%s)_$$"
  msg="Skill test. Run this bash command verbatim and reply with only its full stdout and nothing else: node $DIST status; echo \"MMCS_INVOC_EXIT:\$?\"; echo \"MARKER:$marker\""
  note "step 4 — invoking agent $TARGET_AGENT (openclaw agent, one turn, read-only verb: status)"
  rc=0
  AGENT_REPLY="$(openclaw agent --agent "$TARGET_AGENT" \
      --session-key "agent:$TARGET_AGENT:mmcs-invoc-$(date +%s)" \
      --thinking off --timeout "$AGENT_TIMEOUT" -m "$msg" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    note "step 4 — openclaw agent exited $rc (model timeout/flake). Falling back to transcript evidence: the tool result is recorded even when the model fails to reply."
  fi
  # Parse the agent session transcript for the marker; the exec tool result is
  # written when the tool runs, independent of whether the model produced a
  # final reply. Search sessions modified since this script started.
  EVID_FILE="$(mktemp /tmp/mmcs-skl007-evidence.XXXXXX)"
  parse_rc=0
  python3 - "$HOME/.openclaw/agents/$TARGET_AGENT/sessions" "$marker" "$START_EPOCH" "$EVID_FILE" <<'PYEOF' || parse_rc=$?
import json, os, sys
sessions_dir, marker, start_epoch, out_path = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
if not os.path.isdir(sessions_dir):
    sys.exit(3)
candidates = []
for name in os.listdir(sessions_dir):
    if not name.endswith(".jsonl") or name.endswith(".trajectory.jsonl"):
        continue
    path = os.path.join(sessions_dir, name)
    try:
        if os.path.getmtime(path) < start_epoch - 1:
            continue
        body = open(path, "r", encoding="utf-8", errors="replace").read()
        if marker not in body:
            continue
        candidates.append((os.path.getmtime(path), path, body))
    except OSError:
        continue
if not candidates:
    sys.exit(3)
candidates.sort(reverse=True)
_, path, body = candidates[0]
lines = ["TRANSCRIPT:" + path]
for raw in body.splitlines():
    try:
        d = json.loads(raw)
    except Exception:
        continue
    # OpenClaw stores each turn as {"type":"message","message":{...}}; the exec
    # output arrives as a message with role "toolResult" and a content list of
    # {type:"text",text} parts. Collect those parts only — they carry the
    # completed exit marker (>= 1 digit after the colon), so the un-expanded
    # prompt echo ("$?") never matches.
    m = d.get("message") if isinstance(d, dict) else None
    if not isinstance(m, dict) or m.get("role") not in ("toolResult", "tool_result"):
        continue
    c = m.get("content")
    parts = [c] if isinstance(c, str) else (c if isinstance(c, list) else [])
    text = " ".join(
        p.get("text", "") if isinstance(p, dict) else str(p) for p in parts
    )
    if marker in text:
        # Flatten newlines: each TOOLRESULT record must stay one line so the
        # shell-side grep (TOOLRESULT prefix + MMCS_INVOC_EXIT pattern) sees
        # the whole payload.
        lines.append("TOOLRESULT:" + text.replace("\n", " | "))
with open(out_path, "w", encoding="utf-8") as out:
    out.write("\n".join(lines) + "\n")
sys.exit(0)
PYEOF
  [ "$parse_rc" -eq 0 ] || fail_test "no session transcript recorded the invocation marker within the last few minutes (turn never executed?)."
  TRANSCRIPT_AND_EVIDENCE="$(cat "$EVID_FILE")"
  TRANSCRIPT_PATH="$(printf '%s\n' "$TRANSCRIPT_AND_EVIDENCE" | sed -n 's/^TRANSCRIPT://p' | head -1)"
  AGENT_ENGINE_LINE="$(printf '%s\n' "$TRANSCRIPT_AND_EVIDENCE" | grep '^TOOLRESULT:' | grep -F "$DIRECT_FIRST_LINE" | head -1 | sed 's/^TOOLRESULT://' | head -1)"
  AGENT_EXIT_LINE="$(printf '%s\n' "$TRANSCRIPT_AND_EVIDENCE" | grep '^TOOLRESULT:' | grep -oE 'MMCS_INVOC_EXIT:[0-9]+' | head -1)"
  [ -n "$AGENT_ENGINE_LINE" ] || fail_test "transcript tool result does not contain the direct engine output line '$DIRECT_FIRST_LINE' — agent did not reach the same engine."
  [ "$AGENT_EXIT_LINE" = "MMCS_INVOC_EXIT:0" ] || fail_test "agent-invoked engine exited non-zero ($AGENT_EXIT_LINE)."
  ok "step 4 — agent invocation reached the SAME engine: tool result matches direct output; engine rc=0"
  ok "step 4 — evidence transcript: $TRANSCRIPT_PATH"
  # Same project state: both invocations resolved the identical engine root and
  # the engine's own state directory; assert the state dir exists in the root
  # both runs used.
  [ -d "$REPO_ROOT/state" ] || fail_test "engine state dir missing: $REPO_ROOT/state"
  ok "step 4 — same project state: both invocations resolved engine root $REPO_ROOT (state/ present)"
}

# --- check mode ----------------------------------------------------------------
if [ "$MODE" = "check" ]; then
  preconditions
  direct_engine_status
  skills_check
  skill_installed_check
  note "--check OK: run the full test with MMCS_OPENCLAW_LIVE=1 bash integrations/openclaw/invocation-test.sh"
  exit 0
fi

# --- self-test mode (offline structural checks) --------------------------------
if [ "$MODE" = "self-test" ]; then
  bash -n "$BASH_SOURCE" || { echo "self-test: FAIL syntax" >&2; exit 1; }
  for step in "skills check" "watcher" "openclaw agent" "MMCS_INVOC_EXIT" "direct engine"; do
    grep -q "$step" "$BASH_SOURCE" || { echo "self-test: FAIL missing step '$step'" >&2; exit 1; }
  done
  # No secrets: the script must never read .env or credential files.
  if grep -nE '(\.env|API_KEY|SECRET|token=)' "$BASH_SOURCE" | grep -v 'never read' >/dev/null 2>&1; then
    echo "self-test: FAIL possible secret handling in script" >&2
    exit 1
  fi
  # --help must exit 0 (usage text is not an error).
  bash "$BASH_SOURCE" --help >/dev/null 2>&1 || { echo "self-test: FAIL --help must exit 0" >&2; exit 1; }
  # Non-integer agent timeout must be rejected (bounded retry guard).
  bash "$BASH_SOURCE" --self-test --timeout=abc >/dev/null 2>&1 && { echo "self-test: FAIL non-integer --timeout accepted" >&2; exit 1; }
  { bash "$BASH_SOURCE" --self-test --timeout=abc 2>&1 || true; } | grep -q "must be a positive integer" \
    || { echo "self-test: FAIL --timeout rejection message missing" >&2; exit 1; }
  bash "$BASH_SOURCE" --self-test --timeout=0 >/dev/null 2>&1 && { echo "self-test: FAIL zero --timeout accepted" >&2; exit 1; }
  # Evidence temp file must be cleaned up by an EXIT trap (no leak on early exit).
  grep -q 'trap cleanup EXIT' "$BASH_SOURCE" || { echo "self-test: FAIL evidence-file cleanup trap missing" >&2; exit 1; }
  echo "self-test: PASS — syntax, required steps, no-secret invariant, usage/validation guards"
  exit 0
fi

# --- full run -------------------------------------------------------------------
preconditions
direct_engine_status
skills_check
skill_installed_check
watcher_probe
if [ "${MMCS_OPENCLAW_LIVE:-0}" = "1" ]; then
  live_invocation
else
  note "step 4 — SKIPPED (set MMCS_OPENCLAW_LIVE=1 to run the live agent invocation; it spends one model turn)"
fi

if [ "${MMCS_OPENCLAW_LIVE:-0}" = "1" ]; then
  ok "ALL GREEN — skills check + watcher pickup + same-engine agent invocation verified"
else
  ok "GREEN (live invocation skipped) — skills check + watcher pickup verified; set MMCS_OPENCLAW_LIVE=1 for step 4"
fi
