/**
 * High-performance hierarchical clustering (UPGMA / average-linkage)
 * Compiled to WebAssembly using Emscripten
 *
 * Key design:
 *  - Stable slot IDs: slot mergeA[i] absorbs mergeB[i]; mergeA[i] < mergeB[i] always.
 *    Slot 0 is always the final root.
 *  - Lance-Williams O(1) distance update per active cluster pair.
 *  - Active-index list for O(n) find-minimum scan over live clusters only.
 *  - Linked-list order tracking: O(1) append per merge.
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include <time.h>

typedef int (*ProgressCallback)(int iteration, int totalIterations);

static ProgressCallback g_progressCallback = NULL;

EMSCRIPTEN_KEEPALIVE
void setProgressCallback(ProgressCallback callback) {
  g_progressCallback = callback;
}

static float euclideanDistance(const float* a, const float* b, int size) {
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
  int* outMergeB,
  int* outOrder
) {
  // --- Distance matrix (full n×n, upper triangle computed, mirrored) ---
  float* distances = (float*)malloc(numSamples * numSamples * sizeof(float));
  if (!distances) return -1;

  clock_t lastProgressTime = clock();
  const clock_t progressInterval = CLOCKS_PER_SEC / 10;
  int totalDistCalcs = numSamples * (numSamples - 1);
  int distCalcsDone = 0;

  for (int i = 0; i < numSamples; i++) {
    distances[i * numSamples + i] = 0.0f;
    const float* vecA = data + i * vectorSize;
    for (int j = i + 1; j < numSamples; j++) {
      float d = euclideanDistance(vecA, data + j * vectorSize, vectorSize);
      distances[i * numSamples + j] = d;
      distances[j * numSamples + i] = d;
      distCalcsDone += 2;

      if (g_progressCallback) {
        clock_t now = clock();
        if (now - lastProgressTime >= progressInterval) {
          if (g_progressCallback(-distCalcsDone, totalDistCalcs) == 0) {
            free(distances);
            return -1;
          }
          lastProgressTime = now;
        }
      }
    }
  }

  // --- Cluster sizes (for Lance-Williams weights) ---
  int* sizes = (int*)malloc(numSamples * sizeof(int));
  if (!sizes) { free(distances); return -1; }
  for (int i = 0; i < numSamples; i++) sizes[i] = 1;

  // --- Active-index list: activeList[0..numActive-1] holds live slot IDs ---
  // activePos[slot] = position in activeList for O(1) swap-with-last removal
  int* activeList = (int*)malloc(numSamples * sizeof(int));
  int* activePos  = (int*)malloc(numSamples * sizeof(int));
  if (!activeList || !activePos) {
    free(distances); free(sizes); free(activeList); free(activePos); return -1;
  }
  for (int i = 0; i < numSamples; i++) {
    activeList[i] = i;
    activePos[i]  = i;
  }
  int numActive = numSamples;

  // --- Linked-list order tracking ---
  // listNext[i] = next sample index in leaf order (-1 = end)
  // listHead[slot] = first sample, listTail[slot] = last sample
  int* listNext = (int*)malloc(numSamples * sizeof(int));
  int* listHead = (int*)malloc(numSamples * sizeof(int));
  int* listTail = (int*)malloc(numSamples * sizeof(int));
  if (!listNext || !listHead || !listTail) {
    free(distances); free(sizes); free(activeList); free(activePos);
    free(listNext); free(listHead); free(listTail);
    return -1;
  }
  for (int i = 0; i < numSamples; i++) {
    listNext[i] = -1;
    listHead[i] = i;
    listTail[i] = i;
  }

  int totalIterations = numSamples - 1;
  lastProgressTime = clock();

  for (int iteration = 0; iteration < totalIterations; iteration++) {
    if (g_progressCallback) {
      clock_t now = clock();
      if (now - lastProgressTime >= progressInterval) {
        if (g_progressCallback(iteration, totalIterations) == 0) {
          free(distances); free(sizes); free(activeList); free(activePos);
          free(listNext); free(listHead); free(listTail);
          return -1;
        }
        lastProgressTime = now;
      }
    }

    // --- Find minimum distance pair among active slots ---
    float minDist = INFINITY;
    int minA = -1, minB = -1;

    for (int ai = 0; ai < numActive; ai++) {
      int i = activeList[ai];
      for (int aj = ai + 1; aj < numActive; aj++) {
        int j = activeList[aj];
        float d = distances[i * numSamples + j];
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

    // Record merge
    outHeights[iteration] = minDist;
    outMergeA[iteration]  = minA;
    outMergeB[iteration]  = minB;

    // --- Lance-Williams UPGMA distance update ---
    for (int ai = 0; ai < numActive; ai++) {
      int k = activeList[ai];
      if (k == minA || k == minB) continue;
      float newDist = ((float)sizeA * distances[minA * numSamples + k] +
                       (float)sizeB * distances[minB * numSamples + k]) / (float)newSize;
      distances[minA * numSamples + k] = newDist;
      distances[k * numSamples + minA] = newDist;
    }

    sizes[minA] = newSize;

    // --- Remove minB from active list (swap with last) ---
    int posB     = activePos[minB];
    int lastSlot = activeList[numActive - 1];
    activeList[posB]    = lastSlot;
    activePos[lastSlot] = posB;
    numActive--;

    // --- Append minB's leaf list to minA ---
    listNext[listTail[minA]] = listHead[minB];
    listTail[minA]           = listTail[minB];
  }

  // --- Write out leaf order from slot 0's linked list ---
  int cur = listHead[0];
  for (int i = 0; i < numSamples; i++) {
    outOrder[i] = cur;
    cur = listNext[cur];
  }

  free(distances);
  free(sizes);
  free(activeList);
  free(activePos);
  free(listNext);
  free(listHead);
  free(listTail);

  return 0;
}
