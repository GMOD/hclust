# How this got fast

Clustering 2,000 samples took 71 seconds when JBrowse first shipped it and takes
0.16 seconds now — **446× faster**. This is what changed, in order. Every number
is measured; see [Methodology](#methodology).

## Where it started: greenelab/hclust

JBrowse clustered with [greenelab/hclust](https://github.com/greenelab/hclust),
a pure-JS AGNES implementation linking on `avgDistance`. This package still
carries its API: `clusterData`, `order` and `clustersGivenK` are inherited
names, and `clustersGivenK` keeps its meaning (modulo an empty slot at index 0
that greenelab returns and this package drops).

Its cost centre is average linkage by definition — the mean over every
cross-pair of two clusters' members, recomputed from the point-distance matrix
each time a pair is weighed. One find-minimum pass over `k` clusters reads

```
Σ over pairs |A| × |B|  =  (N² − Σ|A|²) / 2
```

matrix entries. Merging makes clusters _fewer_ but _bigger_ and the two effects
cancel: with balanced clusters `Σ|A|² ≈ N²/k`, so the pass costs ~`N²/2` lookups
at nearly every iteration however few clusters remain. Over N iterations that is
~N³/2 lookups, each a JS array index through two levels of indirection.

## 1. Port to C and WebAssembly

_Initial commit, Nov 2025._

The algorithm went to C essentially unchanged — `averageDistance()` still summed
over `|A| × |B|` member pairs per candidate pair per iteration — but with point
distances in a flat `float32[N × N]` matrix and member lists in flat `int`
arrays.

**2000 samples: 71.4s → 17.6s (4.1×).** Purely a constant factor: the same ~N³/2
lookups, each now one contiguous float read. The rest was structural — per merge
it `malloc`s an index array, `memcpy`s both children in, frees both, then
compacts the cluster array by shifting everything past the two removed.

## 2. Lance-Williams, stable slots, active list

_`c896acb`, Apr 2026._ The step that changed the algorithm rather than the
language.

**Lance-Williams recurrence.** Average linkage gives the merged cluster's
distance to every other cluster from its children's existing distances:

```
d(A∪B, k) = (|A|·d(A,k) + |B|·d(B,k)) / (|A| + |B|)
```

So the matrix _maintains_ cluster-to-cluster distances instead of recomputing
them from members. A merge costs O(k) updates, and a find-minimum pass becomes
`k²/2` float reads rather than `N²/2` — a term that finally shrinks as clusters
merge, ~N³/6 total.

**Stable slot ids.** A merged cluster reuses the lower of the two slot indices
instead of appending and compacting. No index arrays to copy, no shifting, and
`mergeA[i] < mergeB[i]` always — which is what lets the JS side rebuild the tree
and derive `clustersGivenK` from the merge sequence alone.

**Active-index list.** Swap-with-last removal keeps the live slots contiguous,
so scans iterate `k` live clusters instead of filtering N slots through a flag
array.

**2000 samples: 17.6s → 3.5s (5.0×).**

## 3. Correctness work

_`f3bbab4`, `c77072f`, `d002291`, `388be72`, Apr 2026._ Not speed, but it
constrains what later optimizations may do:

- **Tie-breaking** (`d002291`). On sparse data with many identical rows — BigWig
  coverage vectors, variant densities — strict `<` let one growing cluster
  absorb every tied neighbour in turn, giving a caterpillar dendrogram. Ties now
  break toward the smallest combined cluster size, so tied points form a
  balanced binary tree.
- **Numerical stability** (`388be72`). Distances and Lance-Williams weights
  accumulate in `double`, because N−1 chained float32 updates drift. Merge
  heights clamp to non-decreasing along any root-ward path, since rounding could
  otherwise invert a near-tie and surface as a negative branch length.

## 4. Cached nearest neighbours

_`e6ed69e`, Aug 2026._

After step 2 the find-minimum pass was the whole runtime — `k²/2` reads per
iteration, O(N³) overall — beside an O(N) Lance-Williams update.

The pass finds one pair, so cache one candidate per cluster instead. `nn[i]`
holds the nearest active neighbour of slot `i`, and find-minimum scans `k`
candidates rather than `k²/2` pairs. After a merge only clusters whose cached
neighbour was one of the two merged rescan; everyone else gets an O(1) check
against the new cluster, the only new candidate.

This finds the same pair. Minimising `(distance, combined size)` over the k
candidates is equivalent to minimising over all pairs: for fixed `i` the
combined size is `sizes[i] + sizes[j]` and `sizes[i]` is constant while choosing
`j`, so `i`'s best partner under the pair ordering is exactly `nn[i]`.

**2000 samples: 3.5s → 0.083s (42×).**

One behavioural change came with it. Pairs tied on _both_ distance and combined
size used to fall to `activeList` order, which swap-with-last removal leaves
arbitrary; slot id now breaks the final tie, making the choice canonical. The
v3.0.4 snapshots — including the tie-heavy `sparse-duplicates` datasets — pass
unchanged.

## 5. Stop reading the clock per pair

_`ac57be9`, Aug 2026._

Every benchmark above ran without a progress callback, which hid the largest
cost on the path JBrowse actually uses. With `onProgress` registered, the
distance-matrix loop called `emscripten_get_now()` — a wasm→JS call — once per
pair, purely to check whether 100ms had elapsed. The guard cost several times
more than the distance it guarded.

**5000 samples: 464ms without a callback, 1063ms with one**, for nine progress
reports. Polling the clock every 1024th pair puts that back to 1.0×.

A benchmark that omits an optional argument is not benchmarking the caller's
configuration. `benchmarks/cluster.bench.ts` now runs both paths, so the next
divergence shows up as a number rather than a bug report.

## Results

Three C generations, same data, same binary, best of 3 runs (ms):

| N    | 1. C port | 2. Lance-Williams | 4. cached NN | 1 → 4 |
| ---- | --------: | ----------------: | -----------: | ----: |
| 250  |       132 |                11 |            6 |   22× |
| 500  |       367 |                38 |            7 |   52× |
| 1000 |     1,477 |               217 |           19 |   78× |
| 1500 |     5,310 |               987 |           38 |  140× |
| 2000 |    17,608 |             3,524 |           83 |  212× |

Doubling N from 1000 to 2000 costs 11.9× in the first column and 16× in the
second — both cubic-ish — against 4.4× in the third, which is what quadratic
looks like.

End to end, greenelab/hclust against the shipped build (through WebAssembly, not
native):

| N    | greenelab (ms) | current (ms) | speedup |
| ---- | -------------: | -----------: | ------: |
| 250  |            119 |            2 |     60× |
| 500  |            721 |            6 |    120× |
| 1000 |          6,656 |           21 |    317× |
| 1500 |         28,331 |           53 |    535× |
| 2000 |         71,365 |          160 |    446× |

## What still costs

**Tied input gets much less of this.** Cached-neighbour invalidation is the weak
spot: when many clusters share a nearest neighbour, one merge invalidates many
entries and each rescans. On data with many identical rows the gain over step 2
is ~2–3× rather than ~40× — and that is the sparse-coverage-vector shape, so
real genomic input often lands near the low end.

**Memory is the ceiling, not time.** The distance matrix is a full N×N float32:
400MB at N=10,000, 1.6GB at N=20,000, against a 2GB heap cap (`MAXIMUM_MEMORY`
in `scripts/build_wasm.sh`). N=20,000 clusters in 18.2s; N=24,000 fails the
allocation, reporting the size it could not get rather than the "aborted" it
used to claim. Storing only the upper triangle would halve the matrix and
roughly double that ceiling, at the cost of a strided access — the merge loop
reads both `[i][j]` and the mirrored `[j][i]`.

**The distance matrix build is ~40% of the run** (828ms of 2.3s at N=10,000),
and now that the merge loop is quadratic too, that share stays roughly constant
with N.

It is already vectorised: `scripts/build_wasm.sh` has carried `-msimd128` all
along, and disassembly shows the kernel as `v128.load64_zero` →
`f64x2.promote_low_f32x4` → `f64x2.sub` → `f64x2.mul` → `f64x2.add`. Note the
width — `f64x2` is **two** elements per operation, not four, because the
accumulator is `double`. `f32x4` would double the kernel's throughput for about
20% off the total, and would give back exactly the numerical stability step 3
bought. Bad trade for a library whose output people publish, so this headroom
stays on the table.

## Methodology

Data is `data[i][j] = sin(i·31 + j·7) × 100` with `V = 20`, generated
identically in C and JS.

The three C generations build from their committed sources —
`git show <ref>:src/wasm/distance.c` — with `gcc -O2` and a stub `emscripten.h`,
renaming each generation's two exported symbols so all three link into one
harness and run against the same buffers in the same process. Best of 3 runs per
cell, on a machine held on AC power: CPU scaling made the first attempt
non-monotonic in N.

The greenelab figures call `@greenelab/hclust@0.0.1` from npm under Node 24 with
its progress callback stubbed out. Those are single runs, and JS-vs-native is
not like-for-like — which is why the "current" column beside it goes through
WebAssembly. Treat the last table as order-of-magnitude.

Re-running all of it on different hardware (Aug 2026) reproduced the ratios and
the scaling, with absolute times 1.3–1.5× lower throughout. The milliseconds
belong to the machine; the ratios are the claim.

Generations 2 and 4 got an equivalence check: 28 datasets spanning continuous,
integer, all-zero and sparse-duplicate input, compared merge-for-merge and
height-for-height, plus a check that the cached selection was lex-optimal at all
10,950 merge steps of a five-shape sweep.
