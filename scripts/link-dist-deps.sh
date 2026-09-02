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
    [ -e "$nm/$name" ] || ln -s "../../../$pkg/node_modules/$name" "$nm/$name"
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
echo "dist dep links OK"
