#!/usr/bin/env bash
# install-client.sh — fleet-safe installer for the MMCS mini-movie-creator skill on an OpenClaw client.
#
# Solves Gaps A/B for ANY client box in one idempotent pass:
#   A) Registers the skill in the client's skill-department-map.json (routing map)
#   B) Adds the concise when/how-to-use block to the client's AGENTS.md
# plus copies the skill itself, then runs env-preflight to prove READY.
#
# NEVER touches credentials, models, or client sovereignty. Re-runnable — every
# step is marker/slug-checked (no dupes, no drift). Backups written next to each
# file before mutation.
#
# Usage (run inside the client container as the node user):
#   bash install-client.sh [--skills-dir DIR] [--skill-slot NN] [--map PATH] [--agents PATH]
#   bash install-client.sh --dry-run        # print plan, write nothing
#   bash install-client.sh --fix            # also attempt dependency auto-install (env-preflight --fix)
set -uo pipefail

DRY=0; FIX=0
SKILLS_DIR="${MMCS_SKILLS_DIR:-/home/node/.openclaw/skills}"
SKILL_SLOT="${MMCS_SKILL_SLOT:-75}"
MAP="${MMCS_MAP:-/home/node/.openclaw/skills/23-ai-workforce-blueprint/skill-department-map.json}"
AGENTS="${MMCS_AGENTS:-/home/node/.openclaw/workspace/AGENTS.md}"
REPO_MOUNT="${MMCS_REPO_SRC:-/home/node/mmcs}"
SLUG="mini-movie-creator"

i=0
for a in "$@"; do
  i=$((i+1))
  case "$a" in
    --dry-run) DRY=1 ;;
    --fix) FIX=1 ;;
    -h|--help) sed -n '1,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --skills-dir|--skill-slot|--map|--agents)
      nxt="${@:$((i+1)):1}"
      if [ -z "$nxt" ] || [ "${nxt#--}" != "$nxt" ]; then
        echo "ERROR: $a requires a value" >&2; exit 2
      fi
      case "$a" in
        --skills-dir) SKILLS_DIR="$nxt" ;;
        --skill-slot) SKILL_SLOT="$nxt" ;;
        --map) MAP="$nxt" ;;
        --agents) AGENTS="$nxt" ;;
      esac
      ;;
  esac
done

log() { printf '  %s\n' "$*"; }

# 0. Source skill comes from the MMCS checkout (this repo).
SRC_APPEND_PICK() { :; }
find_src() {
  for c in "${MMCS_ROOT:-}" /home/node/mmcs "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"; do
    if [ -n "$c" ] && [ -d "$c/integrations/openclaw/mini-movie-creator" ]; then echo "$c/integrations/openclaw/mini-movie-creator"; return; fi
  done
  echo "$REPO_MOUNT/integrations/openclaw/mini-movie-creator"
}
SRC_SKILL="$(find_src)"

# 1. Copy the skill into the client's skills dir (slot-scoped, idempotent).
DEST="$SKILLS_DIR/$SKILL_SLOT-$SLUG"
if [ -d "$DEST" ]; then
  log "skill present: $DEST (in place)"
else
  if [ "$DRY" -eq 1 ]; then log "DRY: would cp -r $SRC_SKILL -> $DEST"; else
    mkdir -p "$SKILLS_DIR" && cp -r "$SRC_SKILL" "$DEST" && chmod +x "$DEST/scripts/"*.sh 2>/dev/null || true
    log "skill installed -> $DEST"
  fi
fi

# 2. Register in routing map (Gap A) — slug-checked, idempotent.
if ! command -v python3 >/dev/null 2>&1; then log "BLOCKED: python3 missing (map insert needs it)"; exit 2; fi
MAP_PY="$(cat <<'PYEOF'
import json, sys, shutil
path, slug, slot, dest = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    d = json.load(open(path))
except FileNotFoundError:
    d = {"skills": []}
shutil.copy2(path, path + ".bak-mmcs75")
skills = d.get("skills", [])
if any(s.get("slug") == slug for s in skills):
    print("map: already registered")
else:
    skills.append({
        "skill": slot,
        "slug": slug,
        "name": slug,
        "client_facing": True,
        "description": "Drive the local MMCS engine CLI: concept to QC'd video episode with locked character, approval gates, $25 spend wall, GHL archival (KIE, not fal.ai).",
        "departments": ["video"],
        "roles": [{"dept": "video", "slug": "automated-video-production-specialist-openmontage", "primary": False}],
    })
    d["skills"] = skills
    json.dump(d, open(path, "w"), indent=2)
    print("map: registered", slug)
PYEOF
)"
if [ "$DRY" -eq 1 ]; then log "DRY: would register $SLUG in $MAP"; else
  python3 -c "$MAP_PY" "$MAP" "$SLUG" "$SKILL_SLOT" "$DEST"
fi

# 3. AGENTS.md when/how block (Gap B) — marker-checked, idempotent.
MARK="## MMCS mini-movie engine (skill $SKILL_SLOT)"
BLOCK="
$MARK
Series/episodes with a LOCKED recurring character → skills/$SKILL_SLOT-$SLUG (engine CLI at /home/node/mmcs; preflight: skills/$SKILL_SLOT-$SLUG/scripts/env-preflight.sh; provider = KIE_API_KEY, never fal.ai).
One-off montage / brief → finished video → 47-movie-producer instead.
"
if [ -f "$AGENTS" ] && grep -qF "$MARK" "$AGENTS"; then
  log "AGENTS.md: block already present"
else
  if [ "$DRY" -eq 1 ]; then log "DRY: would append block to $AGENTS"; else
    cp "$AGENTS" "$AGENTS.bak-mmcs75" 2>/dev/null || true
    printf '%s' "$BLOCK" >> "$AGENTS"
    log "AGENTS.md: block appended"
  fi
fi

# 4. Preflight (prove READY; --fix attempts dependency repair).
if [ "$DRY" -eq 1 ]; then log "DRY: preflight would run"; exit 0; fi
PF="$DEST/scripts/env-preflight.sh"
if [ -f "$PF" ]; then
  if [ "$FIX" -eq 1 ]; then bash "$PF" --fix; else bash "$PF"; fi
else
  log "BLOCKED: env-preflight.sh missing at $PF"; exit 2
fi

exit 0
