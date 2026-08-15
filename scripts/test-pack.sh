#!/usr/bin/env bash
# Smoke-test the published artifact: npm pack, install into a scratch dir, and
# cluster a small matrix through both the ESM and CJS entry points.
#
# `pnpm test` runs against src/, so nothing else in the repo can see the shape
# of the package. The bug class this exists to catch is the wasm bundle going
# missing from esm/ or dist/ (tsc only emits .ts -> .js; the bundle rides along
# only because of `allowJs`), or arriving with the wrong module type. Either
# ships green and fails at import time for downstream consumers — this is how
# @gmod/bbi@9.0.11 shipped broken.

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$PKG_DIR"
TARBALL="$(npm pack --silent --pack-destination "$SCRATCH")"

# What the tarball CONTAINS, before anything is installed from it.
check_tarball_contents() {
  local listing
  listing="$(tar tzf "$SCRATCH/$TARBALL")"

  # (1) the wasm bundle reaches both output dirs. tsc copies it out of
  # src/wasm/ only under `allowJs`; without that it is invisible to the
  # compiler and the published package imports a file that isn't there.
  local missing=()
  for f in package/esm/wasm/distance.js package/dist/wasm/distance.js; do
    grep -qxF "$f" <<<"$listing" || missing+=("$f")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "error: wasm bundle missing from the tarball:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    return 1
  fi

  # (2) a declaration file that is really a bundle. Under allowJs tsc emits a
  # .d.ts for the inlined bundle, and where it infers a giant string literal
  # type it writes the whole bundle out again as a declaration. 32 KB is far
  # above any real declaration here and far below that regression.
  local big
  big="$(tar tzvf "$SCRATCH/$TARBALL" |
    awk '$NF ~ /\.d\.ts$/ && $3 > 32768 { print $3, $NF }')"
  if [ -n "$big" ]; then
    echo "error: oversized .d.ts in the tarball — a literal type of a bundle, not a declaration:" >&2
    echo "$big" >&2
    return 1
  fi
}
check_tarball_contents

cd "$SCRATCH"
cat >package.json <<'JSON'
{
  "name": "hclust-pack-test",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
JSON
npm install --silent --no-audit --no-fund "./$TARBALL" >/dev/null

# Clustering is what actually instantiates the wasm module — importing the
# entry point alone would not, so a broken bundle has to be run to be caught.
cat >smoke.mjs <<'JS'
import { clusterObject, toNewick, fromNewick } from '@gmod/hclust'
const result = await clusterObject({
  data: { A: [1, 2, 3], B: [1.5, 2.5, 3.5], C: [10, 11, 12] },
})
if (result.order.length !== 3) throw new Error('bad order (ESM)')
if (fromNewick(toNewick(result.tree)).children?.length !== 2) {
  throw new Error('newick round-trip failed (ESM)')
}
if (result.clustersGivenK.length !== 3) throw new Error('bad clustersGivenK (ESM)')
console.log('esm: clustered ok')
JS

cat >smoke.cjs <<'JS'
const { clusterObject, toNewick, fromNewick } = require('@gmod/hclust')
;(async () => {
  const result = await clusterObject({
    data: { A: [1, 2, 3], B: [1.5, 2.5, 3.5], C: [10, 11, 12] },
  })
  if (result.order.length !== 3) throw new Error('bad order (CJS)')
  if (fromNewick(toNewick(result.tree)).children?.length !== 2) {
    throw new Error('newick round-trip failed (CJS)')
  }
  if (result.clustersGivenK.length !== 3) throw new Error('bad clustersGivenK (CJS)')
  console.log('cjs: clustered ok')
})().catch(e => { console.error(e); process.exit(1) })
JS

node smoke.mjs
node smoke.cjs
