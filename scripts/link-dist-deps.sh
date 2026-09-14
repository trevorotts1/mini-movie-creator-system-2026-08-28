#!/bin/bash
# link-dist-deps.sh — after `tsc -p packages/tsconfig.pkg.json`, link every
# package's declared dependencies into its packages/dist/<pkg>/ slice so
# Node's ancestor resolution finds them at runtime (the composite emit lives
# outside each package dir, so node_modules lookups fail without this).
set -e
# Anchor: repo root = parent of scripts/ (or CWD when run from a copy)
if [ -f "packages/tsconfig.pkg.json" ]; then REPO="$(pwd)"; elif [ -f "scripts/link-dist-deps.sh" ]; then REPO="$(cd "$(dirname "$0")/.." && pwd)"; else REPO="${MMCS_ROOT:-$(pwd)}"; fi
cd "$REPO"

for pkg_dir in packages/dist/*/; do
  pkg=$(basename "$pkg_dir")
  pj="packages/$pkg/package.json"
  [ -f "$pj" ] || continue
  nm="packages/dist/$pkg/node_modules"
  mkdir -p "$nm/@mmcs"
  # third-party deps
  for name in $(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1])).get('dependencies', {}).keys()))" "$pj"); do
    if [[ "$name" == @mmcs/* ]]; then continue; fi
    [ -e "$nm/$name" ] && continue
    if [ ! -e "packages/$pkg/node_modules/$name" ]; then
      # A declared-but-uninstalled dependency must not abort the whole build;
      # the runtime will surface it as ERR_MODULE_NOT_FOUND at import time.
      echo "link-dist-deps: WARN $pkg declares $name but it is not installed; skipped" >&2
      continue
    fi
    case "$name" in
      # Scoped packages live under a scope directory that may not exist yet, and
      # sit one level deeper, so the relative prefix gains a level.
      @*) mkdir -p "$nm/${name%%/*}"; ln -s "../../../../$pkg/node_modules/$name" "$nm/$name" ;;
      *)  ln -s "../../../$pkg/node_modules/$name" "$nm/$name" ;;
    esac
  done
  # engine workspace deps (link to the source package; exports maps make the
  # source package resolve to the same dist slice)
  for name in $(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1])).get('dependencies', {}).keys()))" "$pj"); do
    if [[ "$name" != @mmcs/* ]]; then continue; fi
    short="${name#@mmcs/}"
    mkdir -p "$nm/@mmcs"
    if [ -L "$nm/@mmcs/$short" ]; then
      tgt=$(readlink "$nm/@mmcs/$short")
      [ "$tgt" = "../../../../$short" ] || { rm "$nm/@mmcs/$short"; ln -s "../../../../$short" "$nm/@mmcs/$short"; }
    elif [ ! -e "$nm/@mmcs/$short" ]; then
      ln -s "../../../../$short" "$nm/@mmcs/$short"
    fi
  done
done

# Bridge each package's package.json `exports` map onto the composite emit layout.
# The exports map declares "./dist/*", but tsconfig.pkg.json emits to
# packages/dist/<pkg>/src/*. Without this bridge, Node resolves the exports map to a
# non-existent packages/<pkg>/dist/... and the CLI dies with ERR_MODULE_NOT_FOUND
# before it can run a single verb. Idempotent; never clobbers a real directory.
for pkg_dir in packages/dist/*/; do
  pkg=$(basename "$pkg_dir")
  [ -f "packages/$pkg/package.json" ] || continue
  target="../dist/$pkg/src"
  if [ -L "packages/$pkg/dist" ]; then
    [ "$(readlink "packages/$pkg/dist")" = "$target" ] || { rm "packages/$pkg/dist"; ln -s "$target" "packages/$pkg/dist"; }
  elif [ ! -e "packages/$pkg/dist" ]; then
    ln -s "$target" "packages/$pkg/dist"
  fi
done
echo "package dist bridges OK"
echo "dist dep links OK"
