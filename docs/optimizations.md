# How the clustering got fast

Clustering the 2,504 samples of 1000 Genomes by genotype over a 100 kb window
(3,105 variant columns) took 94 seconds with the JavaScript library JBrowse
first shipped, and takes 2.3 seconds now, **41× faster**. The ratio depends on
the window width. The merge loop went from most of a minute to a fraction of a
second, but the distance build got under 10× faster, and the wider the window,
the larger the share of the run the distance build takes. Across the windows in
[Results](#results), the end-to-end gain runs from 8× at 22,513 columns, where
the distance build is nearly the whole run, to 93× for 5,008 haplotypes at 2,311
columns, where greenelab's merge is most of its run.

The changes follow, in order. Every number is measured on real genotypes; see
[Methodology](#methodology).

## Starting point: greenelab/hclust

JBrowse clustered with [greenelab/hclust](https://github.com/greenelab/hclust),
a pure-JS AGNES implementation linking on `avgDistance`. This package keeps its
API: `clusterData`, `order` and `clustersGivenK` are greenelab's names, and
`clustersGivenK` keeps its meaning, except for an empty slot at index 0 that
greenelab returns and this package drops.

greenelab's cost centre is average linkage, which it computes from the
definition: the mean distance over every cross-pair of two clusters' members,
recomputed from the point-distance matrix each time it weighs a pair. One
find-minimum pass over `k` clusters reads

```
Σ over pairs |A| × |B|  =  (N² − Σ|A|²) / 2
```

matrix entries. Each merge leaves _fewer_ but _bigger_ clusters, and the two
effects cancel. With balanced clusters `Σ|A|² ≈ N²/k`, so the pass costs ~`N²/2`
lookups at nearly every iteration however few clusters remain. Over N iterations
that is ~N³/2 lookups, each a JS array index through two levels of indirection.

## 1. Port to C and WebAssembly

_Initial commit, Nov 2025._

The port kept the algorithm essentially unchanged, so `averageDistance()` still
summed over `|A| × |B|` member pairs per candidate pair per iteration. It stored
point distances in a flat `float32[N × N]` matrix and member lists in flat `int`
arrays.

**2504 × 3105: 94 s → 27 s (3.4×)**, greenelab in node against the port compiled
natively. The gain is purely a constant factor: the port makes the same ~N³/2
lookups, each now one contiguous float read. The rest was structural. Per merge,
the port `malloc`s an index array, `memcpy`s both children in, frees both, then
compacts the cluster array by shifting everything past the two removed.

## 2. Lance-Williams, stable slots, active list

_`c896acb`, Apr 2026._ Step 1 changed the language, and this step changed the
algorithm.

**Lance-Williams recurrence.** Average linkage gives the merged cluster's
distance to every other cluster from its children's existing distances:

```
d(A∪B, k) = (|A|·d(A,k) + |B|·d(B,k)) / (|A| + |B|)
```

With the recurrence, the merge loop _updates_ the cluster-to-cluster distances
in the matrix instead of recomputing them from members. A merge costs O(k)
updates, and a find-minimum pass reads `k²/2` floats rather than `N²/2`. Unlike
`N²/2`, the `k²/2` term shrinks as clusters merge, so the passes total ~N³/6.

**Stable slot ids.** A merged cluster reuses the lower of the two slot indices
instead of appending and compacting. A merge copies no index arrays and shifts
nothing, and `mergeA[i] < mergeB[i]` always holds, so the JS side can rebuild
the tree and derive `clustersGivenK` from the merge sequence alone.

**Active-index list.** Swap-with-last removal keeps the live slots contiguous,
so scans iterate `k` live clusters instead of filtering N slots through a flag
array.

**2504 × 3105: 27.4 s → 8.7 s (3.1×).**

## 3. Correctness work

_`f3bbab4`, `c77072f`, `d002291`, `388be72`, Apr 2026._ These commits fixed
correctness rather than speed, and they constrain what later optimizations may
do:

- **Tie-breaking** (`d002291`). On sparse data with many identical rows, such as
  BigWig coverage vectors or variant densities, strict `<` let one growing
  cluster absorb every tied neighbour in turn, giving a caterpillar dendrogram.
  Ties now break toward the smallest combined cluster size, so tied points form
  a balanced binary tree.
- **Numerical stability** (`388be72`). Distances and Lance-Williams weights
  accumulate in `double`, because N−1 chained float32 updates accumulate
  rounding error. Merge heights clamp to non-decreasing along any root-ward
  path, since rounding could otherwise invert a near-tie and produce a negative
  branch length.

## 4. Cached nearest neighbours

_`e6ed69e`, Aug 2026._

After step 2 the find-minimum pass was the whole merge loop (`k²/2` reads per
iteration, O(N³) overall) beside an O(N) Lance-Williams update.

The pass looks for one pair, so step 4 caches one candidate per cluster instead.
`nn[i]` holds the nearest active neighbour of slot `i`, and find-minimum scans
`k` candidates rather than `k²/2` pairs. After a merge, only clusters whose
cached neighbour was one of the two merged rescan. Every other cluster gets an
O(1) check against the new cluster, which is the only new candidate.

The cached search finds the same pair as the full scan. Minimising
`(distance, combined size)` over the k candidates is equivalent to minimising
over all pairs, because for fixed `i` the combined size is `sizes[i] + sizes[j]`
and `sizes[i]` is constant while choosing `j`, so `i`'s best partner under the
pair ordering is exactly `nn[i]`.

**2504 × 3105: 8.7 s → 4.9 s (1.8×).** The merge loop all but vanished, so the
remaining time is the distance build, still step 1's scalar all-double kernel.
At 2,357 columns the same generation takes 3.6 s, 74% of the time for 76% of the
columns, so the time is proportional to the column count, as it is when the
distance build is the whole run. Steps 6 and 7 speed up the distance build.

Step 4 also changed one behaviour. Pairs tied on _both_ distance and combined
size used to fall to `activeList` order, which swap-with-last removal leaves
arbitrary; slot id now breaks the final tie, making the choice canonical. The
v3.0.4 snapshots, including the tie-heavy `sparse-duplicates` datasets, pass
unchanged.

## 5. Stop reading the clock per pair

_`ac57be9`, Aug 2026._

Every benchmark of the time ran without a progress callback, so none of them
measured the largest cost on the path JBrowse uses. With `onProgress`
registered, the distance-matrix loop called `emscripten_get_now()`, a wasm→JS
call, once per pair, purely to check whether 100ms had elapsed. The guard cost
several times more than the distance it guarded, and more than doubled the call.
Reading the clock every 1024th pair instead removed the cost.

A benchmark that omits an optional argument measures a different configuration
than the caller's. `benchmarks/cluster.bench.ts` now runs both paths, so the
benchmark output shows the next divergence between them.

## 6. Real widths, and the first call

_Aug 2026._ Steps 1 to 5 were developed against 20-column synthetic data, where
the merge loop is the cost. JBrowse hands over one column per variant site in
the window, which on a 1000 Genomes window at the default filters is 2,000 to
22,000 columns. At those widths the distance build is 97 to 100% of the run and
the merge loop is ~40 ms. `pnpm bench:real` measures those widths on a bundled
slice of real genotypes (`benchmarks/data/`), each case in a fresh process.

Each case needs a fresh process, because the first `clusterData` call in a
process ran the distance build at 1.05 G pair-elements/s and every later one at
1.95. Node `--no-liftoff` closed the gap. V8 promotes a wasm function out of its
Liftoff baseline tier on call count and has no on-stack replacement, and
`hierarchicalCluster` did the whole build in one call, so the first call stayed
baseline to the end. A best-of-N benchmark in one process hides the first-call
cost, as omitting the callback hid the cost step 5 removed. Chrome tiers the
same way, and the first clustering in a JBrowse worker is the one the user is
waiting on.

Step 6 moved the per-row work into a separate function, `distanceRowChunk`,
called once per 256 pairs. V8 promotes it on call count a few thousand calls in,
and the outer loop that stays baseline does nothing but count. **First call at
2504 × 3106: 13.0s → 7.1s**, warm unchanged. We tried a cache-blocked variant
first, and it cost 15% warm, because with a 96 KB block both operands come out
of L2 instead of one from L1 and one streaming, and the kernel was not
memory-bound anyway.

## 7. f32x4 differences, f64x2 sums

_Aug 2026._ The kernel promoted every element to double before the subtract, so
it ran at `f64x2` width, two elements per operation. Now the subtract and square
are `f32x4` and the promotion to `f64x2` happens every 16 elements, after a
pairwise add of four vectors, so a float lane never sums more than four
non-negative terms before reaching the double accumulator. With at most four
terms per lane, the relative error stays within a few float ulps independent of
V. A plain float32 sum's error grows with the vector length, which is the
failure mode step 3 guarded against. On every real matrix we checked, merges,
heights and leaf order are bit-identical to the all-double kernel, and the
v3.0.4 snapshots pass unchanged.

**2504 × 3106: 7.0s → 2.8s (2.5×)**; 1.45 → 3.5 G pair-elements/s.

## Results

End to end, greenelab/hclust against the shipped build, through WebAssembly,
each a first call in a fresh process:

| Case                              | N × V        | greenelab | current | speedup |
| --------------------------------- | ------------ | --------: | ------: | ------: |
| 100 kb window, MAF 0, samples     | 2504 × 3105  |    93.7 s |  2.29 s |     41× |
| 100 kb window, MAF 0, haplotypes  | 5008 × 3098  |   831.1 s |  16.6 s |     50× |
| 1 Mb window, MAF 0.05, samples    | 2504 × 2357  |    89.0 s |  1.75 s |     51× |
| 1 Mb window, MAF 0.05, haplotypes | 5008 × 2311  |   758.5 s |  8.16 s |     93× |
| 1 Mb window, MAF 0, samples       | 2504 × 22513 |   251.7 s |  30.5 s |      8× |
| 1 Mb window, MAF 0, haplotypes    | 5008 × 22382 |  1177.4 s |  73.6 s |     16× |

Two costs set the ratio. greenelab's merge is O(N³) and ignores the columns, so
it dominates the narrow windows, where doubling the rows costs greenelab about
9×; there the speedup is the merge's, and it is largest. The distance build is
O(N²V) in both implementations, which differ there only in kernel and runtime,
so the 22,513-column samples window, nearly all distance build in both, has a
speedup close to the distance build's alone.

Three C generations, compiled natively, same matrices, best of 3 runs (ms):

| N × V       | 1. C port | 2. Lance-Williams | 4. cached NN | 1 → 4 |
| ----------- | --------: | ----------------: | -----------: | ----: |
| 2504 × 3105 |    27,442 |             8,729 |        4,861 |  5.6× |
| 2504 × 2357 |    23,819 |             6,567 |        3,588 |  6.6× |

Generation 4 is the distance build of step 1 with the merge loop nearly gone;
steps 6 and 7 are wasm-specific and have no native column.

The end-to-end and generations tables come from an i9-9880H laptop running Linux
while other work intermittently shared the CPU (load average 1 to 6 on 8 cores),
so their absolute times are high. The idle `bench:real` run below, on an
i9-9980HK, has the 22,513-column samples case at 23.0 s rather than 30.5 s.
Treat the ratios as the claim, to within tens of percent.

Real genotypes at JBrowse's widths, `pnpm bench:real`, before and after steps 6
and 7, on the same machine in one sitting (ms → s):

| Case                              | N × V        |                     5.0.0 |              after 6 + 7 |           speedup |
| --------------------------------- | ------------ | ------------------------: | -----------------------: | ----------------: |
| 100 kb window, MAF 0, samples     | 2504 × 3106  | 5.0 s (first call 12.6 s) | 2.7 s (first call 2.8 s) | 1.9× (4.5× first) |
| 1 Mb window, MAF 0.05, samples    | 2504 × 2357  |                     4.5 s |                    2.1 s |              2.1× |
| 1 Mb window, MAF 0.05, haplotypes | 5008 × 2311  |                    16.8 s |                    9.3 s |              1.8× |
| 1 Mb window, MAF 0, samples       | 2504 × 22514 |                    38.3 s |                   23.0 s |              1.7× |
| 1 Mb window, MAF 0, haplotypes    | 5008 × 22383 |                   156.9 s |                   98.0 s |              1.6× |

The 5.0.0 column is warm calls; the after column is `bench:real` itself, whose
first-call and warm numbers now agree to within 5%. Absolute times are one
i9-9980HK laptop, single threaded, and the rows vary with thermal state (the
2.5× in step 7 was an A/B in one sitting; across sittings the same cases spread
1.6 to 2.1×). Rerun `pnpm bench:real` on an idle machine before quoting a
number. We discarded a run taken while other work shared the CPU, because it
came out 2 to 3× slower across the board.

## Remaining costs

Tied input, meaning data with many identical rows such as sparse coverage
vectors or genotypes over a narrow window, gains far less from step 4 than
continuous data does. When many clusters share a nearest neighbour, one merge
invalidates many cached entries, and each of those clusters rescans.

Memory, rather than time, limits the input size. The distance matrix is a full
N×N float32: 400MB at N=10,000, 1.6GB at N=20,000, against a 2GB heap cap
(`MAXIMUM_MEMORY` in `scripts/build_wasm.sh`). N=20,000 fits. At N=24,000 the
allocation fails, and the error reports the size it could not get rather than a
bare "aborted". Storing only the upper triangle would halve the matrix and
roughly double that ceiling, at the cost of strided access, because the merge
loop reads both `[i][j]` and the mirrored `[j][i]`.

At real widths the distance matrix build is the run. At the thousands of columns
JBrowse passes, it takes 97 to 100% of the time, and step 7's kernel is the
current version of it: `f32x4` subtract and square, `f64x2` accumulate every 16
elements, ~3.5 G pair-elements/s single threaded. The remaining options are
memory-level parallelism and the GPU. A compute shader doing the same Euclidean
build, one thread per pair with no tiling, ran 6 to 12× faster than the step 7
kernel (12 to 19× faster than 5.0.0) on the bundled 1000 Genomes matrices
(measured in jbrowse-components, `browser-tests/probe-gpu-distance-matrix.ts`).

`clusterData({ distances })` takes that matrix and runs only the merge loop on
it. The build here writes the upper triangle and the merge entry mirrors it, so
a producer fills the same half. With a `distances` input the merge loop is the
whole call, so step 6's tiering problem came back. As one long call, the merge
loop stayed in V8's baseline tier and took 285 ms at N = 2504 on the first call,
against ~100 ms warm. Each merge is now a separate function, `mergeStep`, and
the first call takes 155 ms.

## Methodology

Each table above has a command that regenerates it:

```
pnpm bench:generations   # the three C generations
pnpm bench:greenelab     # greenelab vs the shipped wasm
pnpm bench:real          # the shipped wasm, first call and warm
```

`bench:generations`, `bench:greenelab` and `bench:real` read the same input.
`scripts/real-matrices.mjs` parses the bundled VCF with node alone and builds
matrices the way `plugins/variants` in jbrowse-components does: one column per
ALT allele, dosage scaled to 2/called, no-calls imputed to the site mean, one
0/1 row per haplotype in phased mode. Pass case indices to `bench:generations`
or `bench:greenelab` to choose windows.

`bench:real` spawns a child process per case so the first call is a real first
call.

`bench:generations` compiles each generation from the commit that introduced it
(`25fb205`, `c896acb`, `e6ed69e`) with `cc -O2` and a stub `emscripten.h`,
renaming its two exported symbols so all three link into one harness and run
against the same buffers in the same process. It reports the best of 3 runs per
cell. Run it on AC power. It defaults to the two 2504-sample windows narrow
enough for generation 1 to finish a run in under a minute.

`bench:greenelab` installs `@greenelab/hclust@0.0.1` into a gitignored `build/`
and calls it with its progress callback stubbed out. Each implementation runs
each case once, in a fresh process, so both are first calls. It takes about an
hour over every case, most of it greenelab's merge on the 5,008-row windows.

We checked generations 2 and 4 for equivalence on 28 datasets spanning
continuous, integer, all-zero and sparse-duplicate input, comparing them
merge-for-merge and height-for-height. We also checked that the cached selection
was lex-optimal at all 10,950 merge steps of a five-shape sweep.
