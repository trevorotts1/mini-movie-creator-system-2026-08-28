#!/usr/bin/env bash
# docs-verify.sh — REL-006 release gate for spec §33 documentation deliverables.
#
# Checks, from the repo root:
#   1. every docs file this task owns exists and is non-trivial (>200 bytes);
#   2. every repo-relative path referenced inside those docs exists in the
#      repo (backticked path literals only — never URL fragments, never
#      prose).
#
# Exit 0 = clean. Exit 1 = a doc is missing/thin or a referenced repo path
# does not exist (and the referenced file itself is exempt from re-scanning).
# Exit 2 = usage/invocation error. POSIX sh.

set -u

fail=0
scanned=0
referenced_checked=0
cd "$(dirname "$0")/../.." || exit 2

# The §33 deliverable set REL-006 owns. Files prior tasks own
# (installation.md, first-series.md, provider-capabilities/, environment/,
# e2e/provider-smoke reports, ARCHITECTURE.md, BASELINE-REPORT.md) are
# checked for existence too — REL-006's README indexes all of them.
OWNED_DOCS='
docs/character-library.md
docs/approvals.md
docs/provider-setup.md
docs/ghl-setup.md
docs/skill-installs.md
docs/cost-controls.md
docs/capability-registry.md
docs/adding-a-provider.md
docs/troubleshooting.md
docs/recovery.md
docs/standalone-path.md
'

INDEXED_DOCS='
docs/installation.md
docs/first-series.md
docs/ARCHITECTURE.md
docs/upstream-audit/preservation-map.md
docs/provider-capabilities/README.md
docs/provider-capabilities/agnes.md
docs/provider-capabilities/kie.md
docs/provider-capabilities/fish-audio.md
docs/provider-capabilities/ghl.md
docs/provider-capabilities/reasoning-models.md
docs/environment/ENVIRONMENT.md
docs/environment/CLAUDE-NINE-CAPABILITIES.md
docs/e2e-dry-run-report.md
docs/provider-smoke-report.md
README.md
'

printf '=== MMCS docs-verify (REL-006) ===\n'

# 1. Owned docs: exist + >200 bytes.
for f in $OWNED_DOCS; do
  if [ ! -f "$f" ]; then
    printf 'FAIL missing doc: %s\n' "$f"
    fail=1
  else
    size=$(wc -c < "$f")
    if [ "$size" -le 200 ]; then
      printf 'FAIL trivial doc (%s bytes, need >200): %s\n' "$size" "$f"
      fail=1
    else
      scanned=$((scanned + 1))
      printf 'ok   %s (%s bytes)\n' "$f" "$size"
    fi
  fi
done

# 2. Indexed docs (referenced from README/index tables): exist.
for f in $INDEXED_DOCS; do
  if [ ! -f "$f" ]; then
    printf 'FAIL missing indexed doc: %s\n' "$f"
    fail=1
  else
    printf 'ok   indexed %s\n' "$f"
  fi
done

# 3. Every backticked repo-relative path referenced from the owned docs
#    must exist on disk. Heuristic, deliberately conservative:
#    - token starts with a known repo prefix (docs/ packages/ apps/
#      scripts/ skills/ integrations/ state/ examples/ remotion/)
#    - token is a single path literal (no spaces)
#    - skip code fences / inline snippets: only `...` spans WITHOUT a space
#      or shell metacharacter are treated as paths.
for f in $OWNED_DOCS; do
  [ -f "$f" ] || continue
  # sed: strip fenced blocks (``` .. ```), then pull single-line backticked
  # spans; awk keeps only path-like tokens.
  tokens=$(sed -e '/^```/,/^```$/d' "$f" | sed -n 's/.*`\([^`]*\)`.*/\1/p' || true)
  for t in $tokens; do
    case "$t" in
      */*) ;;
      *) continue ;;
    esac
    case "$t" in
      docs/*|packages/*|apps/*|scripts/*|skills/*|integrations/*|state/*|examples/*|remotion/*) ;;
      *) continue ;;
    esac
    case "$t" in
      *" "*|*";"*|*"|"*) continue ;;
    esac
    case "$t" in
      *'$'*|"("*|")("*|")"*|*"*"*) continue ;;
    esac
    strip=${t%% *}
    if [ ! -e "$strip" ]; then
      printf 'FAIL %s references missing path: %s\n' "$f" "$t"
      fail=1
    else
      referenced_checked=$((referenced_checked + 1))
      printf 'ok   %s -> %s exists\n' "$f" "$strip"
    fi
  done
done

printf '\n%s docs owned (all >200B), %s referenced paths verified.\n' "$scanned" "$referenced_checked"
if [ "$fail" -ne 0 ]; then
  printf 'docs-verify: FAIL\n'
  exit 1
fi
printf 'docs-verify: PASS\n'
exit 0