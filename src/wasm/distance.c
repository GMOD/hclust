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
 *    rebuilt tree, so this routine only emits merges + heights.
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <emscripten.h>
#include <wasm_simd128.h>

typedef int (*ProgressCallback)(int iteration, int totalIterations);

static ProgressCallback g_progressCallback = NULL;

EMSCRIPTEN_KEEPALIVE
void setProgressCallback(ProgressCallback callback) {
  g_progressCallback = callback;
}

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

// Distances from row i to rows j0..jEnd-1, upper triangle only; the merge
// loop mirrors it. A separate function on purpose: V8 promotes a wasm function from its baseline
// tier on call count, without on-stack replacement, so one long call that did
// all the work stayed baseline to the end and the first clustering in a fresh
// worker ran at half speed.
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

typedef struct {
  float* distances;
  int numSamples;
  int* sizes;
  int* activeList;
  int* activePos;
  float* lastHeight;
  int* nn;
  float* nnDist;
  int* nnSize;
  int numActive;
} MergeState;

// One merge: pick the pair, record it, fold the Lance-Williams update in, and
// refresh the cached neighbours. Its own function for the reason
// distanceRowChunk is: V8 tiers a wasm function up on how much it has run,
// without on-stack replacement, and the merge loop as one long call stayed
// in the baseline tier to the end — a precomputed matrix went through it at
// half speed on the first call in a process.
__attribute__((noinline))
static void mergeStep(
  MergeState* st, int iteration,
  float* outHeights, int* outMergeA, int* outMergeB
) {
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
  outHeights[iteration] = clampedHeight;
  // minA is the surviving slot for the merged cluster, so future merges
  // involving this cluster will read lastHeight[minA]. minB is retired.
  lastHeight[minA] = clampedHeight;
  outMergeA[iteration]  = minA;
  outMergeB[iteration]  = minB;

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

// The merge loop on an n×n matrix the caller owns. Only the upper triangle
// (j > i) is read on entry — it is mirrored below, so a caller may fill just
// that half — and the matrix is scratch afterwards: the Lance-Williams update
// rewrites it in place.
static int clusterDistances(
  float* distances,
  int numSamples,
  float* outHeights,
  int* outMergeA,
  int* outMergeB
) {
  // -3 until proven otherwise: every allocation below jumps to cleanup on
  // failure, and reporting that as -1 told the caller its own cancellation had
  // fired.
  int rc = -3;
  int*   sizes      = NULL;
  int*   activeList = NULL;
  int*   activePos  = NULL;
  float* lastHeight = NULL;
  int*   nn         = NULL;
  float* nnDist     = NULL;
  int*   nnSize     = NULL;

  for (int i = 0; i < numSamples; i++) {
    distances[(size_t)i * numSamples + i] = 0.0f;
    for (int j = i + 1; j < numSamples; j++) {
      distances[(size_t)j * numSamples + i] = distances[(size_t)i * numSamples + j];
    }
  }

  // --- Cluster sizes (for Lance-Williams weights) ---
  sizes = (int*)malloc(numSamples * sizeof(int));
  if (!sizes) goto cleanup;
  for (int i = 0; i < numSamples; i++) sizes[i] = 1;

  // --- Active-index list: activeList[0..numActive-1] holds live slot IDs ---
  // activePos[slot] = position in activeList for O(1) swap-with-last removal
  activeList = (int*)malloc(numSamples * sizeof(int));
  activePos  = (int*)malloc(numSamples * sizeof(int));
  if (!activeList || !activePos) goto cleanup;
  for (int i = 0; i < numSamples; i++) {
    activeList[i] = i;
    activePos[i]  = i;
  }
  int numActive = numSamples;

  // --- Per-slot last merge height, for monotonicity clamp.
  // UPGMA satisfies reducibility, so heights should be non-decreasing along
  // any root-ward path. Float rounding in repeated Lance-Williams updates can
  // produce tiny inversions on near-tied data, which manifests as negative
  // branch lengths in dendrograms. We clamp each merge height up to the max
  // of its children's last merge heights.
  lastHeight = (float*)malloc(numSamples * sizeof(float));
  if (!lastHeight) goto cleanup;
  for (int i = 0; i < numSamples; i++) lastHeight[i] = 0.0f;

  // --- Cached nearest neighbour per active slot ---
  // nn[i] is the active j minimising (distance, size, slot) lexicographically.
  // Because the pair's combined size is sizes[i] + sizes[j] and sizes[i] is
  // fixed while choosing j, minimising sizes[j] minimises the combined size,
  // so the winner over all pairs is the best of these k candidates — the same
  // pair the exhaustive scan used to find. See findNearest for the slot term.
  nn     = (int*)malloc(numSamples * sizeof(int));
  nnDist = (float*)malloc(numSamples * sizeof(float));
  nnSize = (int*)malloc(numSamples * sizeof(int));
  if (!nn || !nnDist || !nnSize) goto cleanup;
  for (int ai = 0; ai < numActive; ai++) {
    findNearest(activeList[ai], distances, numSamples, sizes,
                activeList, numActive, nn, nnDist, nnSize);
  }

  MergeState st = {
    distances, numSamples, sizes, activeList, activePos, lastHeight,
    nn, nnDist, nnSize, numActive
  };
  int totalIterations = numSamples - 1;
  const double progressIntervalMs = 100.0;
  double lastProgressTime = emscripten_get_now();

  for (int iteration = 0; iteration < totalIterations; iteration++) {
    if (g_progressCallback) {
      double now = emscripten_get_now();
      if (now - lastProgressTime >= progressIntervalMs) {
        if (g_progressCallback(iteration, totalIterations) == 0) {
          rc = -1;
          goto cleanup;
        }
        lastProgressTime = now;
      }
    }

    mergeStep(&st, iteration, outHeights, outMergeA, outMergeB);
  }

  rc = 0;

cleanup:
  free(sizes);
  free(activeList);
  free(activePos);
  free(lastHeight);
  free(nn);
  free(nnDist);
  free(nnSize);
  return rc;
}

// Clusters a precomputed n×n distance matrix — any metric, built anywhere
// (a GPU, another library) — skipping the distance phase above. Same contract
// as clusterDistances: the upper triangle is what is read, and the matrix is
// scratch afterwards.
EMSCRIPTEN_KEEPALIVE
int clusterDistanceMatrix(
  float* distances,
  int numSamples,
  float* outHeights,
  int* outMergeA,
  int* outMergeB
) {
  for (int i = 0; i < numSamples; i++) {
    for (int j = i + 1; j < numSamples; j++) {
      if (!isfinite(distances[(size_t)i * numSamples + j])) return -2;
    }
  }
  return clusterDistances(distances, numSamples, outHeights, outMergeA, outMergeB);
}

EMSCRIPTEN_KEEPALIVE
int hierarchicalCluster(
  const float* data,
  int numSamples,
  int vectorSize,
  float* outHeights,
  int* outMergeA,
  int* outMergeB
) {
  // --- Validate input: a single NaN/Inf would silently poison every distance
  // (NaN compares false everywhere, so find-min would skip it and produce a
  // wrong tree without an error). Cheap one-pass guard at entry.
  {
    size_t total = (size_t)numSamples * (size_t)vectorSize;
    for (size_t i = 0; i < total; i++) {
      if (!isfinite(data[i])) return -2;
    }
  }

  // --- Distance matrix (full n×n, upper triangle computed here) ---
  float* distances = (float*)malloc((size_t)numSamples * numSamples * sizeof(float));
  if (!distances) return -3;

  double lastProgressTime = emscripten_get_now();
  const double progressIntervalMs = 100.0;
  int totalDistCalcs = numSamples * (numSamples - 1);
  int distCalcsDone = 0;

  // Reading the clock is a wasm->JS call (performance.now()), so doing it once
  // per pair — as this used to — costs several times more than the distance it
  // guards: with a callback registered, n=5000 went from 464ms to 1063ms to
  // deliver nine progress reports. Sample it every 1024th pair instead. That is
  // well under the 100ms report interval at any realistic vector width, so the
  // cadence is unchanged and the check leaves the profile.
  const int clockPollInterval = 1024;
  int sinceClockPoll = 0;

  const int chunkPairs = 256;
  for (int i = 0; i < numSamples; i++) {
    for (int j0 = i + 1; j0 < numSamples; j0 += chunkPairs) {
      int jEnd = j0 + chunkPairs < numSamples ? j0 + chunkPairs : numSamples;
      distanceRowChunk(data, vectorSize, numSamples, i, j0, jEnd, distances);
      distCalcsDone += 2 * (jEnd - j0);

      if (g_progressCallback && (sinceClockPoll += jEnd - j0) >= clockPollInterval) {
        sinceClockPoll = 0;
        double now = emscripten_get_now();
        if (now - lastProgressTime >= progressIntervalMs) {
          if (g_progressCallback(-distCalcsDone, totalDistCalcs) == 0) {
            free(distances);
            return -1;
          }
          lastProgressTime = now;
        }
      }
    }
  }

  int rc = clusterDistances(distances, numSamples, outHeights, outMergeA, outMergeB);
  free(distances);
  return rc;
}
