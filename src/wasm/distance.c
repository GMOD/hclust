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
#include <emscripten.h>

typedef int (*ProgressCallback)(int iteration, int totalIterations);

static ProgressCallback g_progressCallback = NULL;

EMSCRIPTEN_KEEPALIVE
void setProgressCallback(ProgressCallback callback) {
  g_progressCallback = callback;
}

static float euclideanDistance(
  const float* __restrict__ a,
  const float* __restrict__ b,
  int size
) {
  float sum = 0.0f;
  int i = 0;
  for (; i + 3 < size; i += 4) {
    float d0 = a[i]   - b[i];
    float d1 = a[i+1] - b[i+1];
    float d2 = a[i+2] - b[i+2];
    float d3 = a[i+3] - b[i+3];
    sum += d0*d0 + d1*d1 + d2*d2 + d3*d3;
  }
  for (; i < size; i++) {
    float d = a[i] - b[i];
    sum += d * d;
  }
  return sqrtf(sum);
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
    float minDist = INFINITY;
    int minA = -1, minB = -1;

    for (int ai = 0; ai < numActive; ai++) {
      int i = activeList[ai];
      const float* row = distances + (size_t)i * numSamples;
      for (int aj = ai + 1; aj < numActive; aj++) {
        int j = activeList[aj];
        float d = row[j];
        if (d < minDist) {
          minDist = d;
          minA = i;
          minB = j;
        }
      }
    }

    // Stable slot: ensure minA < minB (lower slot absorbs higher)
    if (minA > minB) { int tmp = minA; minA = minB; minB = tmp; }

    int sizeA = sizes[minA];
    int sizeB = sizes[minB];
    int newSize = sizeA + sizeB;

    outHeights[iteration] = minDist;
    outMergeA[iteration]  = minA;
    outMergeB[iteration]  = minB;

    // --- Lance-Williams UPGMA distance update ---
    // Precomputed weights save a division per inner iteration.
    const float wA = (float)sizeA / (float)newSize;
    const float wB = (float)sizeB / (float)newSize;
    float* rowA = distances + (size_t)minA * numSamples;
    const float* rowB = distances + (size_t)minB * numSamples;
    for (int ai = 0; ai < numActive; ai++) {
      int k = activeList[ai];
      if (k == minA || k == minB) continue;
      float newDist = wA * rowA[k] + wB * rowB[k];
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
  return rc;
}
