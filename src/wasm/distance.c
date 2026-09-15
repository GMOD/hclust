/**
 * High-performance hierarchical clustering (UPGMA / average-linkage)
 * Compiled to WebAssembly using Emscripten
 *
 * Algorithm: UPGMA (Unweighted Pair Group Method with Arithmetic Mean)
 *   Sokal & Michener (1958). "A statistical method for evaluating systematic
 *   relationships." University of Kansas Science Bulletin, 38, 1409-1438.
 *
 * Distance update: Lance-Williams recurrence for average linkage
 *   Lance & Williams (1967). "A general theory of classificatory sorting
 *   strategies." Computer Journal, 9(4), 373-380.
 *
 * Key design:
 *  - Stable slot IDs: slot mergeA[i] absorbs mergeB[i]; mergeA[i] < mergeB[i] always.
 *    Slot 0 is always the final root.
 *  - Lance-Williams O(1) distance update per active cluster pair.
 *  - Active-index list holding live slot IDs, for O(1) removal.
 *  - Cached nearest neighbour per active cluster, so find-minimum scans k
 *    candidates rather than all k(k-1)/2 pairs. A full rescan of every pair
 *    each iteration is what made this O(n^3); it is now ~O(n^2) on data with
 *    few ties, which took n=5000 from 67s to 1.1s.
 *  - Leaf order is derived on the JS side from a left-to-right traversal of the
 *    rebuilt tree, so a run only emits merges + heights.
 *  - A run is a heap-allocated Run that clusterStep advances in time-bounded
 *    slices, so the caller can yield between them. Nothing is global, so runs
 *    interleave.
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <emscripten.h>
#include <wasm_simd128.h>

// Differences and squares in f32x4, promoted and accumulated in f64x2 every
// 16 elements, so a float lane never sums more than four non-negative terms
// before reaching the double accumulator. That bounds the relative error at a
// few float ulps independent of vector length, where a plain float32 sum grows
// with it; the previous all-double kernel ran at half the throughput.
static float euclideanDistance(
  const float* __restrict__ a,
  const float* __restrict__ b,
  int size
) {
  v128_t acc0 = wasm_f64x2_splat(0.0);
  v128_t acc1 = wasm_f64x2_splat(0.0);
  int i = 0;
  for (; i + 15 < size; i += 16) {
    v128_t d0 = wasm_f32x4_sub(wasm_v128_load(a + i), wasm_v128_load(b + i));
    v128_t d1 = wasm_f32x4_sub(wasm_v128_load(a + i + 4), wasm_v128_load(b + i + 4));
    v128_t d2 = wasm_f32x4_sub(wasm_v128_load(a + i + 8), wasm_v128_load(b + i + 8));
    v128_t d3 = wasm_f32x4_sub(wasm_v128_load(a + i + 12), wasm_v128_load(b + i + 12));
    v128_t s = wasm_f32x4_add(
      wasm_f32x4_add(wasm_f32x4_mul(d0, d0), wasm_f32x4_mul(d1, d1)),
      wasm_f32x4_add(wasm_f32x4_mul(d2, d2), wasm_f32x4_mul(d3, d3)));
    acc0 = wasm_f64x2_add(acc0, wasm_f64x2_promote_low_f32x4(s));
    acc1 = wasm_f64x2_add(acc1, wasm_f64x2_promote_low_f32x4(wasm_i32x4_shuffle(s, s, 2, 3, 2, 3)));
  }
  double sum = wasm_f64x2_extract_lane(acc0, 0) + wasm_f64x2_extract_lane(acc0, 1)
             + wasm_f64x2_extract_lane(acc1, 0) + wasm_f64x2_extract_lane(acc1, 1);
  for (; i < size; i++) {
    float d = a[i] - b[i];
    sum += (double)(d * d);
  }
  return (float)sqrt(sum);
}

// Distances from row i to rows j0..jEnd-1, upper triangle only;
// mirrorDistances copies it down. A separate function on purpose: V8 promotes
// a wasm function from its baseline tier on call count, without on-stack
// replacement, so one long call that did all the work stayed baseline to the
// end and the first clustering in a fresh worker ran at half speed.
__attribute__((noinline))
static void distanceRowChunk(
  const float* data, int vectorSize, int numSamples,
  int i, int j0, int jEnd, float* distances
) {
  const float* vecA = data + (size_t)i * vectorSize;
  for (int j = j0; j < jEnd; j++) {
    distances[(size_t)i * numSamples + j] =
      euclideanDistance(vecA, data + (size_t)j * vectorSize, vectorSize);
  }
}

// Nearest active neighbour of slot i, by (distance, cluster size, slot id).
//
// The slot id is the last resort and exists to make the choice canonical.
// Without it the winner among pairs tied on both distance and size falls out
// of activeList order, which the swap-with-last removal below leaves
// arbitrary — so two runs that merge the same clusters could still disagree
// about which tied pair went first. Ties like that are the norm on sparse
// data (many identical all-zero rows), not a corner case.
static void findNearest(
  int i,
  const float* distances, int numSamples,
  const int* sizes,
  const int* activeList, int numActive,
  int* nn, float* nnDist, int* nnSize
) {
  const float* row = distances + (size_t)i * numSamples;
  float bestDist = INFINITY;
  int bestJ = -1, bestSize = INT_MAX;
  for (int aj = 0; aj < numActive; aj++) {
    int j = activeList[aj];
    if (j == i) continue;
    float d = row[j];
    int s = sizes[j];
    if (d < bestDist ||
        (d == bestDist && (s < bestSize || (s == bestSize && j < bestJ)))) {
      bestDist = d; bestJ = j; bestSize = s;
    }
  }
  nn[i] = bestJ; nnDist[i] = bestDist; nnSize[i] = bestSize;
}

enum { STEP_DONE = 0, STEP_MORE = 1, STEP_NON_FINITE = 2 };

enum {
  PHASE_VALIDATE_ROWS,
  PHASE_DISTANCES,
  PHASE_MIRROR,
  PHASE_NEAREST,
  PHASE_MERGE,
  PHASE_FINISHED
};

enum { PROGRESS_DISTANCE = 0, PROGRESS_CLUSTERING = 1 };

// Reading the clock is a wasm->JS call (performance.now()). Once per pair it
// cost several times the distance it guarded — n=5000 went from 464ms to
// 1063ms — so each phase counts work instead and reads the clock once per
// this many units, roughly one float operation each: a fraction of a
// millisecond at any vector width.
static const size_t WORK_PER_CLOCK_READ = 1 << 18;
static const size_t PAIR_OVERHEAD_WORK = 64;

typedef struct {
  // phase (PROGRESS_*), current, total
  int progress[3];
  int phase;
  int matrixInput;
  int numSamples;
  int vectorSize;
  float* data;
  float* distances;
  void* merges;
  float* heights;
  int* mergeA;
  int* mergeB;
  int* sizes;
  int* activeList;
  int* activePos;
  float* lastHeight;
  int* nn;
  float* nnDist;
  int* nnSize;
  int numActive;
  int row;
  int col;
  int pairsDone;
  int iteration;
} Run;

// One merge: pick the pair, record it, fold the Lance-Williams update in, and
// refresh the cached neighbours. Noinline for the reason distanceRowChunk is:
// the merge loop as one long call stayed in V8's baseline tier to the end, and
// a precomputed matrix went through it at half speed on the first call.
__attribute__((noinline))
static void mergeStep(Run* st, int iteration) {
  float* distances = st->distances;
  const int numSamples = st->numSamples;
  int* sizes = st->sizes;
  int* activeList = st->activeList;
  int* activePos = st->activePos;
  float* lastHeight = st->lastHeight;
  int* nn = st->nn;
  float* nnDist = st->nnDist;
  int* nnSize = st->nnSize;
  int numActive = st->numActive;

  // --- Find minimum distance pair among active slots ---
  // Tie-break by smallest combined cluster size: with sparse / many-tie
  // input data (e.g. lots of identical zero-vector rows), strict < tie-
  // breaking would cause one growing cluster to absorb every tied neighbor
  // in sequence — a chain dendrogram. Preferring pairs of small clusters
  // on ties yields a balanced binary merge of the tied points instead.
  float minDist = INFINITY;
  int minA = -1, minB = -1;
  int minPairSize = INT_MAX;

  for (int ai = 0; ai < numActive; ai++) {
    int i = activeList[ai];
    int j = nn[i];
    float d = nnDist[i];
    int pairSize = sizes[i] + nnSize[i];
    int lo = i < j ? i : j, hi = i < j ? j : i;
    int bestLo = minA < minB ? minA : minB;
    int bestHi = minA < minB ? minB : minA;
    if (d < minDist ||
        (d == minDist &&
         (pairSize < minPairSize ||
          (pairSize == minPairSize &&
           (lo < bestLo || (lo == bestLo && hi < bestHi)))))) {
      minDist = d;
      minA = i;
      minB = j;
      minPairSize = pairSize;
    }
  }

  // Stable slot: ensure minA < minB (lower slot absorbs higher)
  if (minA > minB) { int tmp = minA; minA = minB; minB = tmp; }

  int sizeA = sizes[minA];
  int sizeB = sizes[minB];
  int newSize = sizeA + sizeB;

  // Monotonicity clamp: a merge cannot sit lower than either of its children.
  float clampedHeight = minDist;
  if (lastHeight[minA] > clampedHeight) clampedHeight = lastHeight[minA];
  if (lastHeight[minB] > clampedHeight) clampedHeight = lastHeight[minB];
  st->heights[iteration] = clampedHeight;
  // minA is the surviving slot for the merged cluster, so future merges
  // involving this cluster will read lastHeight[minA]. minB is retired.
  lastHeight[minA] = clampedHeight;
  st->mergeA[iteration] = minA;
  st->mergeB[iteration] = minB;

  // --- Lance-Williams UPGMA distance update ---
  // Weights and the multiply-add are computed in double so n-1 chained
  // updates don't accumulate float32 rounding error in the distance matrix.
  // Storage stays float for memory; only intermediates are promoted.
  const double wA = (double)sizeA / (double)newSize;
  const double wB = (double)sizeB / (double)newSize;
  float* rowA = distances + (size_t)minA * numSamples;
  const float* rowB = distances + (size_t)minB * numSamples;
  for (int ai = 0; ai < numActive; ai++) {
    int k = activeList[ai];
    if (k == minA || k == minB) continue;
    float newDist = (float)(wA * (double)rowA[k] + wB * (double)rowB[k]);
    rowA[k] = newDist;
    distances[(size_t)k * numSamples + minA] = newDist;
  }

  sizes[minA] = newSize;

  // --- Remove minB from active list (swap with last) ---
  int posB     = activePos[minB];
  int lastSlot = activeList[numActive - 1];
  activeList[posB]    = lastSlot;
  activePos[lastSlot] = posB;
  numActive--;
  st->numActive = numActive;

  if (numActive < 2) return;

  // --- Refresh cached neighbours ---
  // minA's whole row just moved, so it rescans. For everyone else the only
  // new candidate is minA, an O(1) check — unless their cached neighbour was
  // minA or minB, which is now stale (minB is gone, minA's distance moved)
  // and has to rescan. That rescan is the algorithm's weak spot: on data
  // where many clusters share a neighbour it fires often and the iteration
  // degrades back toward O(k), which is why heavily tied input sees ~3x here
  // rather than the ~40x that data with distinct distances gets.
  findNearest(minA, distances, numSamples, sizes,
              activeList, numActive, nn, nnDist, nnSize);
  for (int ai = 0; ai < numActive; ai++) {
    int k = activeList[ai];
    if (k == minA) continue;
    if (nn[k] == minA || nn[k] == minB) {
      findNearest(k, distances, numSamples, sizes,
                  activeList, numActive, nn, nnDist, nnSize);
    } else {
      float d = distances[(size_t)k * numSamples + minA];
      if (d < nnDist[k] ||
          (d == nnDist[k] &&
           (newSize < nnSize[k] ||
            (newSize == nnSize[k] && minA < nn[k])))) {
        nn[k] = minA; nnDist[k] = d; nnSize[k] = newSize;
      }
    }
  }
}

// A single NaN/Inf would poison every distance it touches — NaN compares false
// everywhere, so find-min would skip it and return a wrong tree without error.
static int validateRows(Run* run, double deadline) {
  const float* data = run->data;
  const size_t n = run->numSamples;
  const size_t v = run->vectorSize;
  size_t work = 0;
  for (size_t i = run->row; i < n; i++) {
    const float* row = data + i * v;
    for (size_t k = 0; k < v; k++) {
      if (!isfinite(row[k])) return STEP_NON_FINITE;
    }
    work += v + 1;
    if (work >= WORK_PER_CLOCK_READ) {
      work = 0;
      if (emscripten_get_now() >= deadline) {
        run->row = i + 1;
        return STEP_MORE;
      }
    }
  }
  run->row = 0;
  run->col = 1;
  run->phase = PHASE_DISTANCES;
  return STEP_DONE;
}

// The upper triangle, in chunks of pairs sized so one chunk stays under a
// clock read at any vector width.
static int fillDistances(Run* run, double deadline) {
  const float* data = run->data;
  float* distances = run->distances;
  const int n = run->numSamples;
  const int v = run->vectorSize;
  const size_t pairWork = (size_t)v + PAIR_OVERHEAD_WORK;
  size_t chunkPairs = WORK_PER_CLOCK_READ / pairWork;
  if (chunkPairs > 256) chunkPairs = 256;
  if (chunkPairs < 1) chunkPairs = 1;
  int i = run->row;
  int j0 = run->col;
  int pairsDone = run->pairsDone;
  size_t work = 0;
  while (i < n - 1) {
    int jEnd = n - j0 > (int)chunkPairs ? j0 + (int)chunkPairs : n;
    distanceRowChunk(data, v, n, i, j0, jEnd, distances);
    pairsDone += jEnd - j0;
    work += (size_t)(jEnd - j0) * pairWork;
    if (jEnd == n) {
      i++;
      j0 = i + 1;
    } else {
      j0 = jEnd;
    }
    if (work >= WORK_PER_CLOCK_READ) {
      work = 0;
      if (emscripten_get_now() >= deadline) {
        run->row = i;
        run->col = j0;
        run->pairsDone = pairsDone;
        run->progress[1] = 2 * pairsDone;
        return STEP_MORE;
      }
    }
  }
  free(run->data);
  run->data = NULL;
  run->row = 0;
  run->phase = PHASE_MIRROR;
  run->progress[0] = PROGRESS_CLUSTERING;
  run->progress[1] = 0;
  run->progress[2] = n - 1;
  return STEP_DONE;
}

// Only the upper triangle is read on entry; this copies it into the lower one,
// checking a precomputed matrix for NaN/Inf on the way.
static int mirrorDistances(Run* run, double deadline) {
  float* distances = run->distances;
  const size_t n = run->numSamples;
  const int validate = run->matrixInput;
  size_t work = 0;
  for (size_t i = run->row; i < n; i++) {
    const float* row = distances + i * n;
    if (validate) {
      for (size_t j = i + 1; j < n; j++) {
        if (!isfinite(row[j])) return STEP_NON_FINITE;
      }
    }
    distances[i * n + i] = 0.0f;
    for (size_t j = i + 1; j < n; j++) {
      distances[j * n + i] = row[j];
    }
    work += n - i;
    if (work >= WORK_PER_CLOCK_READ) {
      work = 0;
      if (emscripten_get_now() >= deadline) {
        run->row = i + 1;
        return STEP_MORE;
      }
    }
  }
  run->row = 0;
  run->phase = PHASE_NEAREST;
  return STEP_DONE;
}

// nn[i] is the active j minimising (distance, size, slot) lexicographically.
// Because the pair's combined size is sizes[i] + sizes[j] and sizes[i] is
// fixed while choosing j, minimising sizes[j] minimises the combined size, so
// the winner over all pairs is the best of these k candidates — the same pair
// an exhaustive scan finds. See findNearest for the slot term.
static int seedNearest(Run* run, double deadline) {
  const float* distances = run->distances;
  const int n = run->numSamples;
  const int* sizes = run->sizes;
  const int* activeList = run->activeList;
  int* nn = run->nn;
  float* nnDist = run->nnDist;
  int* nnSize = run->nnSize;
  size_t work = 0;
  for (int ai = run->row; ai < n; ai++) {
    findNearest(activeList[ai], distances, n, sizes,
                activeList, n, nn, nnDist, nnSize);
    work += n;
    if (work >= WORK_PER_CLOCK_READ) {
      work = 0;
      if (emscripten_get_now() >= deadline) {
        run->row = ai + 1;
        return STEP_MORE;
      }
    }
  }
  run->iteration = 0;
  run->phase = PHASE_MERGE;
  return STEP_DONE;
}

// The clock is read after every merge: a merge that invalidates many cached
// neighbours costs O(k^2), so a work count would undershoot on tied input.
static int mergeAll(Run* run, double deadline) {
  const int total = run->numSamples - 1;
  int iteration = run->iteration;
  while (iteration < total) {
    mergeStep(run, iteration);
    iteration++;
    if (iteration < total && emscripten_get_now() >= deadline) {
      run->iteration = iteration;
      run->progress[1] = iteration;
      return STEP_MORE;
    }
  }
  run->iteration = total;
  run->progress[1] = total;
  run->phase = PHASE_FINISHED;
  return STEP_DONE;
}

EMSCRIPTEN_KEEPALIVE
void clusterFree(Run* run) {
  if (!run) return;
  free(run->data);
  free(run->distances);
  free(run->merges);
  free(run->sizes);
  free(run->activeList);
  free(run->activePos);
  free(run->lastHeight);
  free(run->nn);
  free(run->nnDist);
  free(run->nnSize);
  free(run);
}

static Run* allocateRun(int numSamples, int vectorSize, int matrixInput) {
  Run* run = (Run*)calloc(1, sizeof(Run));
  if (!run) return NULL;
  const size_t n = numSamples;
  run->numSamples = numSamples;
  run->vectorSize = vectorSize;
  run->matrixInput = matrixInput;
  run->distances = (float*)malloc(n * n * sizeof(float));
  if (!matrixInput) {
    run->data = (float*)malloc(n * (size_t)vectorSize * sizeof(float));
  }
  run->merges     = malloc((n - 1) * (sizeof(float) + 2 * sizeof(int)));
  run->sizes      = (int*)malloc(n * sizeof(int));
  run->activeList = (int*)malloc(n * sizeof(int));
  run->activePos  = (int*)malloc(n * sizeof(int));
  run->lastHeight = (float*)malloc(n * sizeof(float));
  run->nn         = (int*)malloc(n * sizeof(int));
  run->nnDist     = (float*)malloc(n * sizeof(float));
  run->nnSize     = (int*)malloc(n * sizeof(int));
  if (!run->distances || (!matrixInput && !run->data) || !run->merges ||
      !run->sizes || !run->activeList || !run->activePos ||
      !run->lastHeight || !run->nn || !run->nnDist || !run->nnSize) {
    clusterFree(run);
    return NULL;
  }
  run->heights = (float*)run->merges;
  run->mergeA = (int*)((char*)run->merges + (n - 1) * sizeof(float));
  run->mergeB = run->mergeA + (n - 1);
  // lastHeight is the monotonicity clamp: float rounding in chained
  // Lance-Williams updates can produce tiny inversions on near-tied data,
  // which would draw as negative branch lengths.
  for (size_t i = 0; i < n; i++) {
    run->sizes[i] = 1;
    run->activeList[i] = (int)i;
    run->activePos[i] = (int)i;
    run->lastHeight[i] = 0.0f;
  }
  run->numActive = numSamples;
  return run;
}

// A run over n rows of vectorSize columns. The caller writes the rows into
// clusterInput, then calls clusterStep until it returns STEP_DONE.
EMSCRIPTEN_KEEPALIVE
Run* clusterBeginRows(int numSamples, int vectorSize) {
  Run* run = allocateRun(numSamples, vectorSize, 0);
  if (!run) return NULL;
  run->phase = PHASE_VALIDATE_ROWS;
  run->progress[0] = PROGRESS_DISTANCE;
  run->progress[2] = numSamples * (numSamples - 1);
  return run;
}

// A run over a precomputed n×n matrix — any metric, built anywhere — skipping
// the distance phase. Only the upper triangle is read, and the matrix is
// scratch afterwards: the Lance-Williams update rewrites it in place.
EMSCRIPTEN_KEEPALIVE
Run* clusterBeginMatrix(int numSamples) {
  Run* run = allocateRun(numSamples, 0, 1);
  if (!run) return NULL;
  run->phase = PHASE_MIRROR;
  run->progress[0] = PROGRESS_CLUSTERING;
  run->progress[2] = numSamples - 1;
  return run;
}

EMSCRIPTEN_KEEPALIVE
float* clusterInput(Run* run) {
  return run->matrixInput ? run->distances : run->data;
}

// Advances the run until budgetMs has passed or it finishes. Returns
// STEP_MORE, STEP_DONE, or STEP_NON_FINITE.
EMSCRIPTEN_KEEPALIVE
int clusterStep(Run* run, double budgetMs) {
  const double deadline = emscripten_get_now() + budgetMs;
  for (;;) {
    int rc;
    switch (run->phase) {
      case PHASE_VALIDATE_ROWS: rc = validateRows(run, deadline); break;
      case PHASE_DISTANCES:     rc = fillDistances(run, deadline); break;
      case PHASE_MIRROR:        rc = mirrorDistances(run, deadline); break;
      case PHASE_NEAREST:       rc = seedNearest(run, deadline); break;
      case PHASE_MERGE:         rc = mergeAll(run, deadline); break;
      default:                  return STEP_DONE;
    }
    if (rc != STEP_DONE) return rc;
  }
}

EMSCRIPTEN_KEEPALIVE
const int* clusterProgress(Run* run) {
  return run->progress;
}

// heights, then mergeA, then mergeB, n-1 entries each. Slot mergeA[i] absorbs
// mergeB[i], and mergeA[i] < mergeB[i].
EMSCRIPTEN_KEEPALIVE
const void* clusterMerges(Run* run) {
  return run->merges;
}
