# How this got fast

UPGMA clustering of 2,000 samples took 71 seconds when JBrowse first shipped it
and takes 0.16 seconds now. This is what changed, in order, and why each step
mattered. Numbers are measured, not estimated — see [Methodology](#methodology).

## Where it started: greenelab/hclust

JBrowse originally clustered with
[greenelab/hclust](https://github.com/greenelab/hclust), a pure-JavaScript AGNES
implementation with `avgDistance` as its linkage function. This package still
carries its API: `clusterData`, `order`, and `clustersGivenK` are all inherited
names, and `clustersGivenK` keeps the same meaning (modulo an empty slot at
index 0 that greenelab returns and this package drops).

Its cost centre is average linkage computed by definition. The distance between
two clusters is the mean over every cross-pair of their members, and it is
recomputed from the point-distance matrix each time a pair is considered — so
one find-minimum pass over `k` clusters reads

```
Σ over pairs |A| × |B|  =  (N² − Σ|A|²) / 2
```

matrix entries. The important part is what that expression does as clustering
proceeds: merging makes clusters _fewer_ but _bigger_, and the two effects
cancel. With balanced clusters `Σ|A|² ≈ N²/k`, so the pass costs about `N²/2`
lookups at nearly every iteration regardless of how few clusters are left. Over
N iterations that is ~N³/2, and every one of those lookups is a JS array index
through two levels of object indirection.

## 1. Port to C and WebAssembly

_Initial commit, Nov 2025._

The algorithm was transcribed to C essentially unchanged — `averageDistance()`
still summed over `|A| × |B|` member pairs for every candidate pair, every
iteration — but with the point distances precomputed into a flat
`float32[N × N]` matrix, and the member lists as flat `int` arrays.

**2000 samples: 71.4s → 17.6s.** Purely a constant-factor win: same ~N³/2
lookups, but each is one contiguous float read instead of a JS property lookup.
The cost that remained was structural: per merge it `malloc`s a new index array,
`memcpy`s both children into it, frees both, and then compacts the cluster array
by shifting every element after the two removed.

## 2. Lance-Williams, stable slots, active list

_`c896acb`, Apr 2026._

This is the step that changed the algorithm rather than the language.

**Lance-Williams recurrence.** Average linkage satisfies a recurrence that gives
the merged cluster's distance to every other cluster from the two children's
existing distances:

```
d(A∪B, k) = (|A|·d(A,k) + |B|·d(B,k)) / (|A| + |B|)
```

So cluster-to-cluster distances can be _maintained_ in the matrix rather than
recomputed from members. A merge costs O(k) updates, and — the real win — a
find-minimum pass is now `k²/2` single float reads instead of `N²/2`. That term
finally shrinks as clusters merge: ~N³/6 total, and shrinking fast.

**Stable slot ids.** A merged cluster reuses the lower of the two slot indices
instead of being appended and compacted. No index arrays to copy, no array
shifting, and `mergeA[i] < mergeB[i]` always — which is what lets the JS side
rebuild the tree and derive `clustersGivenK` from the merge sequence alone.

**Active-index list.** Live slots are held in a list with swap-with-last
removal, so scans iterate `k` live clusters instead of filtering N slots through
a flag array.

**2000 samples: 17.6s → 3.5s.**

## 3. Correctness work

_`f3bbab4`, `c77072f`, `d002291`, `388be72`, Apr 2026._

Not speed, but it constrains what any later optimization is allowed to do, so it
belongs in the sequence:

- **Tie-breaking** (`d002291`). On sparse data with many identical rows — BigWig
  coverage vectors, variant densities — strict `<` tie-breaking let one growing
  cluster absorb every tied neighbour in turn, producing a caterpillar
  dendrogram. Ties are now broken toward the smallest combined cluster size,
  which merges tied points into a balanced binary tree instead.
- **Numerical stability** (`388be72`). Distances accumulate in `double` and the
  Lance-Williams weights are computed in `double`, because N−1 chained float32
  updates drift. Merge heights are clamped to be non-decreasing along any
  root-ward path, since float rounding could otherwise invert a near-tie and
  surface as a negative branch length.

## 4. Cached nearest neighbours

_`e6ed69e`, Aug 2026._

After step 2 the find-minimum pass was the entire runtime: `k²/2` reads per
iteration, O(N³) overall, against an O(N) Lance-Williams update sitting right
next to it.

The pass exists to find one pair, so cache one candidate per cluster instead.
`nn[i]` holds the nearest active neighbour of slot `i`; find-minimum then scans
`k` candidates rather than `k²/2` pairs. After a merge, only clusters whose
cached neighbour was one of the two merged need a rescan — everyone else gets an
O(1) check against the new cluster, since it is the only new candidate.

This finds the same pair. Minimising `(distance, combined size)` over the k
candidates is equivalent to minimising it over all pairs: for a fixed `i` the
combined size is `sizes[i] + sizes[j]` and `sizes[i]` is constant while choosing
`j`, so the best partner for `i` under the pair ordering is exactly `nn[i]`.

**2000 samples: 3.5s → 0.083s.**

One behavioural change came with it. Pairs tied on _both_ distance and combined
size used to be settled by `activeList` order, which swap-with-last removal
leaves arbitrary; the caching would have resolved them differently for no stated
reason. Slot id is now the final tie-break, making the order total and the
choice canonical. The v3.0.4 compatibility snapshots — including the tie-heavy
`sparse-duplicates` datasets — pass unchanged.

## 5. Stop reading the clock per pair

_`ac57be9`, Aug 2026._

Everything above was benchmarked with no progress callback, which turned out to
hide the single largest cost on the path JBrowse actually uses. `onProgress`
registers a callback, and the distance-matrix loop then called
`emscripten_get_now()` — a wasm→JS call — once per pair, purely to decide
whether 100ms had elapsed. The guard cost several times more than the distance
it guarded.

**5000 samples: 464ms without a callback, 1063ms with one**, to deliver nine
progress reports. Polling the clock every 1024th pair puts that back to 1.0×.

The lesson is narrower than "don't call JS from wasm": it is that a benchmark
which omits an optional argument is not benchmarking the caller's configuration.
Both paths now measure the same, and `benchmarks/cluster.bench.ts` runs both so
the next divergence shows up as a number rather than a bug report.

## Results

Three C generations, same data, same binary, best of 3 runs (ms):

| N    | 1. C port | 2. Lance-Williams | 4. cached NN |
| ---- | --------: | ----------------: | -----------: |
| 250  |       132 |                11 |            6 |
| 500  |       367 |                38 |            7 |
| 1000 |     1,477 |               217 |           19 |
| 1500 |     5,310 |               987 |           38 |
| 2000 |    17,608 |             3,524 |           83 |

Doubling N from 1000 to 2000 costs 11.9× in the first column and 16× in the
second — both cubic-ish — against 4.4× in the third, which is what quadratic
looks like.

End to end, greenelab/hclust against the current shipped build (through
WebAssembly, not native):

| N    | greenelab (ms) | current (ms) |
| ---- | -------------: | -----------: |
| 250  |            119 |            2 |
| 500  |            721 |            6 |
| 1000 |          6,656 |           21 |
| 1500 |         28,331 |           53 |
| 2000 |         71,365 |          160 |

## What still costs

**Tied input gets much less of this.** The cached-neighbour invalidation is the
weak spot: when many clusters share a nearest neighbour, a single merge
invalidates many cached entries and each one rescans. On data with many
identical rows the speedup over step 2 is ~2–3× rather than ~40×. That is the
sparse-coverage-vector shape, so real genomic input often lands closer to the
low end.

**Memory is the ceiling, not time.** The distance matrix is a full N×N float32:
400MB at N=10,000, 1.6GB at N=20,000. The build caps the heap at 2GB
(`MAXIMUM_MEMORY` in `scripts/build_wasm.sh`), and measured against that,
N=20,000 clusters in 18.2s while N=24,000 fails the allocation — reporting the
size it could not get, rather than the "aborted" it used to claim. Storing only
the upper triangle would halve the matrix and roughly double that ceiling; the
cost is that the merge loop reads both `[i][j]` and the mirrored `[j][i]`, so
one of the two becomes a strided access. Worth measuring before assuming it
wins.

**The distance matrix build is ~40% of the run** (measured: 828ms of 2.3s at
N=10,000), and now that the merge loop is quadratic too, that share stays
roughly constant with N.

It is already vectorised, and not by accident: `scripts/build_wasm.sh` has
carried `-msimd128` all along. Disassembling the module confirms the kernel
compiles to `v128.load64_zero` → `f64x2.promote_low_f32x4` → `f64x2.sub` →
`f64x2.mul` → `f64x2.add`. Note the width — `f64x2` is **two** elements per
operation, not four, because the accumulator is `double`. Going to `f32x4` would
double the kernel's throughput, for about 20% off the total, and would give back
exactly the numerical stability step 3 was added to buy. That is a bad trade for
a library whose output people publish, so the remaining headroom here is
deliberately left on the table.

## Methodology

Data is `data[i][j] = sin(i·31 + j·7) × 100` with `V = 20`, generated
identically in C and JS.

The three C generations are compiled from their actual committed sources —
`git show <ref>:src/wasm/distance.c` — with `gcc -O2` and a stub `emscripten.h`,
then linked into one harness so they run against the same buffers in the same
process. Best of 3 runs per cell; the first attempt at these numbers was
discarded because the laptop dropped off AC power mid-run and CPU scaling made
them non-monotonic in N.

The greenelab figures call `@greenelab/hclust@0.0.1` from npm under Node 24,
with its progress callback stubbed out. Those are single runs, and JS-vs-native
is not a like-for-like comparison — the "current" column beside it goes through
WebAssembly for that reason. Treat the last table as order-of-magnitude.

Equivalence between generations 2 and 4 was checked separately: 28 datasets
spanning continuous, integer, all-zero and sparse-duplicate input, compared
merge-for-merge and height-for-height, plus a check that the cached selection
was lex-optimal at all 10,950 merge steps of a five-shape sweep.
