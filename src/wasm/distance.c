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

typedef int (*ProgressCallback)(int iteration, int totalIterations);

static ProgressCallback g_progressCallback = NULL;

EMSCRIPTEN_KEEPALIVE
void setProgressCallback(ProgressCallback callback) {
  g_progressCallback = callback;
}

// Squared sum is accumulated in double to avoid catastrophic cancellation on
// long vectors — float32 only holds ~7 decimal digits, so a 10k-dimensional
// sum loses meaningful precision. Four parallel partials give the optimizer
// room to vectorize without breaking strict-FP associativity.
static float euclideanDistance(
  const float* __restrict__ a,
  const float* __restrict__ b,
  int size
) {
  double s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0;
  int i = 0;
  for (; i + 3 < size; i += 4) {
    double d0 = (double)a[i]   - (double)b[i];
    double d1 = (double)a[i+1] - (double)b[i+1];
    double d2 = (double)a[i+2] - (double)b[i+2];
    double d3 = (double)a[i+3] - (double)b[i+3];
    s0 += d0 * d0;
    s1 += d1 * d1;
    s2 += d2 * d2;
    s3 += d3 * d3;
  }
  double sum = (s0 + s1) + (s2 + s3);
  for (; i < size; i++) {
    double d = (double)a[i] - (double)b[i];
    sum += d * d;
  }
  return (float)sqrt(sum);
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

EMSCRIPTEN_KEEPALIVE
int hierarchicalCluster(
  const float* data,
  int numSamples,
  int vectorSize,
  float* outHeights,
  int* outMergeA,
  int* outMergeB
) {
  // -3 until proven otherwise: every allocation below jumps to cleanup on
  // failure, and reporting that as -1 told the caller its own cancellation had
  // fired. The n x n matrix is 400MB at n=10,000, so this is a reachable
  // outcome on real input, not a theoretical one.
  int rc = -3;
  float* distances  = NULL;
  int*   sizes      = NULL;
  int*   activeList = NULL;
  int*   activePos  = NULL;
  float* lastHeight = NULL;
  int*   nn         = NULL;
  float* nnDist     = NULL;
  int*   nnSize     = NULL;

  // --- Validate input: a single NaN/Inf would silently poison every distance
  // (NaN compares false everywhere, so find-min would skip it and produce a
  // wrong tree without an error). Cheap one-pass guard at entry.
  {
    size_t total = (size_t)numSamples * (size_t)vectorSize;
    for (size_t i = 0; i < total; i++) {
      if (!isfinite(data[i])) return -2;
    }
  }

  // --- Distance matrix (full n×n, upper triangle computed, mirrored) ---
  distances = (float*)malloc((size_t)numSamples * numSamples * sizeof(float));
  if (!distances) goto cleanup;

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

  for (int i = 0; i < numSamples; i++) {
    float* row = distances + (size_t)i * numSamples;
    row[i] = 0.0f;
    const float* vecA = data + (size_t)i * vectorSize;
    for (int j = i + 1; j < numSamples; j++) {
      float d = euclideanDistance(vecA, data + (size_t)j * vectorSize, vectorSize);
      row[j] = d;
      distances[(size_t)j * numSamples + i] = d;
      distCalcsDone += 2;

      if (g_progressCallback && ++sinceClockPoll >= clockPollInterval) {
        sinceClockPoll = 0;
        double now = emscripten_get_now();
        if (now - lastProgressTime >= progressIntervalMs) {
          if (g_progressCallback(-distCalcsDone, totalDistCalcs) == 0) {
            rc = -1;
            goto cleanup;
          }
          lastProgressTime = now;
        }
      }
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

  int totalIterations = numSamples - 1;
  lastProgressTime = emscripten_get_now();

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

    if (numActive < 2) continue;

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

  rc = 0;

cleanup:
  free(distances);
  free(sizes);
  free(activeList);
  free(activePos);
  free(lastHeight);
  free(nn);
  free(nnDist);
  free(nnSize);
  return rc;
}
