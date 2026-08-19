#!/bin/bash
# Reproduces the C-generation table in docs/optimizations.md.
#
# Each generation is compiled from the commit that introduced it, so the
# columns are the real historical code rather than a reconstruction. Native
# gcc, not emscripten: the point is the algorithmic step, and emsdk is a much
# heavier thing to require of anyone checking the numbers.
#
# Usage: pnpm bench:generations [N ...]
set -euo pipefail

cd "$(dirname "$0")/.."
src=benchmarks/generations
out=build/generations
mkdir -p "$out"

# 1. C port (initial commit), 2. Lance-Williams, 4. cached nearest neighbours.
# Generation 3 is correctness work and changes no column.
refs=(25fb205 c896acb e6ed69e)
gens=(1 2 4)

for i in 0 1 2; do
  g=${gens[$i]}
  git show "${refs[$i]}:src/wasm/distance.c" > "$out/g$g.c"
  cc -O2 -I"$src" -c "$out/g$g.c" -o "$out/g$g.o" \
    -DhierarchicalCluster="hc_g$g" \
    -DsetProgressCallback="spc_g$g"
done

cc -O2 -I"$src" -c "$src/harness.c" -o "$out/harness.o"
cc "$out"/g*.o "$out/harness.o" -lm -o "$out/bench"

echo "Best of 3 runs (ms), data[i][j] = sin(i*31 + j*7) * 100, V = 20"
echo
"$out/bench" "$@"
