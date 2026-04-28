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
 *  - Active-index list for O(n) find-minimum scan over live clusters only.
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

EMSCRIPTEN_KEEPALIVE
int hierarchicalCluster(
  const float* data,
  int numSamples,
  int vectorSize,
  float* outHeights,
  int* outMergeA,
  int* outMergeB
) {
  int rc = -1;
  float* distances  = NULL;
  int*   sizes      = NULL;
  int*   activeList = NULL;
  int*   activePos  = NULL;
  float* lastHeight = NULL;

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

  for (int i = 0; i < numSamples; i++) {
    float* row = distances + (size_t)i * numSamples;
    row[i] = 0.0f;
    const float* vecA = data + (size_t)i * vectorSize;
    for (int j = i + 1; j < numSamples; j++) {
      float d = euclideanDistance(vecA, data + (size_t)j * vectorSize, vectorSize);
      row[j] = d;
      distances[(size_t)j * numSamples + i] = d;
      distCalcsDone += 2;

      if (g_progressCallback) {
        double now = emscripten_get_now();
        if (now - lastProgressTime >= progressIntervalMs) {
          if (g_progressCallback(-distCalcsDone, totalDistCalcs) == 0) goto cleanup;
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

  int totalIterations = numSamples - 1;
  lastProgressTime = emscripten_get_now();

  for (int iteration = 0; iteration < totalIterations; iteration++) {
    if (g_progressCallback) {
      double now = emscripten_get_now();
      if (now - lastProgressTime >= progressIntervalMs) {
        if (g_progressCallback(iteration, totalIterations) == 0) goto cleanup;
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
      const float* row = distances + (size_t)i * numSamples;
      int sizeI = sizes[i];
      for (int aj = ai + 1; aj < numActive; aj++) {
        int j = activeList[aj];
        float d = row[j];
        if (d < minDist) {
          minDist = d;
          minA = i;
          minB = j;
          minPairSize = sizeI + sizes[j];
        } else if (d == minDist) {
          int pairSize = sizeI + sizes[j];
          if (pairSize < minPairSize) {
            minA = i;
            minB = j;
            minPairSize = pairSize;
          }
        }
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
  }

  rc = 0;

cleanup:
  free(distances);
  free(sizes);
  free(activeList);
  free(activePos);
  free(lastHeight);
  return rc;
}
