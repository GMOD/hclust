/**
 * High-performance hierarchical clustering
 * Compiled to WebAssembly using Emscripten
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include <time.h>

// Cluster node structure
typedef struct {
  int* indexes;      // Array of sample indexes in this cluster
  int indexCount;    // Number of indexes
  float height;      // Distance at which cluster was formed
} Cluster;

// Progress callback type
typedef int (*ProgressCallback)(int iteration, int totalIterations);

// Global progress callback
static ProgressCallback g_progressCallback = NULL;

// Register progress callback from JavaScript
EMSCRIPTEN_KEEPALIVE
void setProgressCallback(ProgressCallback callback) {
  g_progressCallback = callback;
}

/**
 * Compute Euclidean distance between two vectors
 */
static float euclideanDistance(const float* a, const float* b, int size) {
  float sum = 0.0f;

  int i = 0;
  for (; i + 3 < size; i += 4) {
    float diff0 = a[i] - b[i];
    float diff1 = a[i+1] - b[i+1];
    float diff2 = a[i+2] - b[i+2];
    float diff3 = a[i+3] - b[i+3];

    sum += diff0 * diff0 + diff1 * diff1 + diff2 * diff2 + diff3 * diff3;
  }

  for (; i < size; i++) {
    float diff = a[i] - b[i];
    sum += diff * diff;
  }

  return sqrtf(sum);
}

/**
 * Compute average linkage distance between two clusters
 */
static float averageDistance(
  const Cluster* clusterA,
  const Cluster* clusterB,
  const float* distances,
  int numSamples
) {
  float sum = 0.0f;

  for (int i = 0; i < clusterA->indexCount; i++) {
    int rowIdx = clusterA->indexes[i];
    const float* distRow = distances + (rowIdx * numSamples);

    for (int j = 0; j < clusterB->indexCount; j++) {
      sum += distRow[clusterB->indexes[j]];
    }
  }

  return sum / (float)(clusterA->indexCount * clusterB->indexCount);
}

/**
 * Perform agglomerative hierarchical clustering (UPGMA)
 * Returns a tree structure encoded as parallel arrays
 *
 * @param data Flattened 2D array of sample data
 * @param numSamples Number of samples
 * @param vectorSize Dimensions per sample
 * @param outHeights Output array for merge heights (length numSamples-1)
 * @param outMergeA Output array for first cluster in each merge (length numSamples-1)
 * @param outMergeB Output array for second cluster in each merge (length numSamples-1)
 * @param outOrder Output array for final sample order (length numSamples)
 */
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
  // Compute distance matrix
  float* distances = (float*)malloc(numSamples * numSamples * sizeof(float));

  clock_t lastProgressTime = clock();
  const clock_t progressInterval = CLOCKS_PER_SEC / 10; // 100ms
  int totalDistanceCalcs = numSamples * (numSamples - 1);
  int distanceCalcsDone = 0;

  for (int i = 0; i < numSamples; i++) {
    distances[i * numSamples + i] = 0.0f;
    const float* vecA = data + (i * vectorSize);
    for (int j = i + 1; j < numSamples; j++) {
      const float* vecB = data + (j * vectorSize);
      float d = euclideanDistance(vecA, vecB, vectorSize);
      distances[i * numSamples + j] = d;
      distances[j * numSamples + i] = d;
      distanceCalcsDone += 2;

      if (g_progressCallback != NULL) {
        clock_t currentTime = clock();
        if (currentTime - lastProgressTime >= progressInterval) {
          g_progressCallback(-distanceCalcsDone, totalDistanceCalcs);
          lastProgressTime = currentTime;
        }
      }
    }
  }

  // Initialize clusters - start with each sample as its own cluster
  Cluster* clusters = (Cluster*)malloc(numSamples * sizeof(Cluster));
  int numClusters = numSamples;

  for (int i = 0; i < numSamples; i++) {
    clusters[i].indexes = (int*)malloc(sizeof(int));
    clusters[i].indexes[0] = i;
    clusters[i].indexCount = 1;
    clusters[i].height = 0.0f;
  }

  int totalIterations = numSamples - 1;
  lastProgressTime = clock();

  // Hierarchical clustering loop
  for (int iteration = 0; iteration < totalIterations; iteration++) {
    if (g_progressCallback != NULL) {
      clock_t currentTime = clock();
      if (currentTime - lastProgressTime >= progressInterval) {
        g_progressCallback(iteration, totalIterations);
        lastProgressTime = currentTime;
      }
    }

    // Find closest pair of clusters
    float minDist = INFINITY;
    int minRow = 0;
    int minCol = 1;

    for (int row = 0; row < numClusters; row++) {
      for (int col = row + 1; col < numClusters; col++) {
        float dist = averageDistance(&clusters[row], &clusters[col], distances, numSamples);
        if (dist < minDist) {
          minDist = dist;
          minRow = row;
          minCol = col;
        }
      }
    }

    // Record the merge
    outHeights[iteration] = minDist;
    outMergeA[iteration] = minRow;
    outMergeB[iteration] = minCol;

    // Merge clusters
    Cluster newCluster;
    newCluster.indexCount = clusters[minRow].indexCount + clusters[minCol].indexCount;
    newCluster.indexes = (int*)malloc(newCluster.indexCount * sizeof(int));
    newCluster.height = minDist;

    // Combine indexes
    memcpy(newCluster.indexes, clusters[minRow].indexes,
           clusters[minRow].indexCount * sizeof(int));
    memcpy(newCluster.indexes + clusters[minRow].indexCount, clusters[minCol].indexes,
           clusters[minCol].indexCount * sizeof(int));

    // Remove merged clusters and add new one
    // Remove higher index first to avoid shifting issues
    int removeFirst = minRow < minCol ? minCol : minRow;
    int removeSecond = minRow < minCol ? minRow : minCol;

    free(clusters[removeFirst].indexes);
    free(clusters[removeSecond].indexes);

    // Shift clusters down
    for (int i = removeFirst; i < numClusters - 1; i++) {
      clusters[i] = clusters[i + 1];
    }
    numClusters--;

    for (int i = removeSecond; i < numClusters - 1; i++) {
      clusters[i] = clusters[i + 1];
    }
    numClusters--;

    // Add new cluster at end
    clusters[numClusters] = newCluster;
    numClusters++;
  }

  // Output final order
  for (int i = 0; i < clusters[0].indexCount; i++) {
    outOrder[i] = clusters[0].indexes[i];
  }

  // Cleanup
  for (int i = 0; i < numClusters; i++) {
    free(clusters[i].indexes);
  }
  free(clusters);
  free(distances);

  return 0; // Success
}
