import { hierarchicalClusterWasm } from './wasm-wrapper.ts'

import type {
  ClusterObjectOptions,
  ClusterOptions,
  ClusterResult,
} from './types.ts'

export async function clusterData({
  data,
  sampleLabels,
  onProgress,
  checkCancellation,
}: ClusterOptions): Promise<ClusterResult> {
  onProgress?.({
    phase: 'init',
    message: 'Running hierarchical clustering in WASM',
    current: 0,
    total: 0,
  })

  const result = await hierarchicalClusterWasm({
    data,
    sampleLabels,
    statusCallback: onProgress,
    checkCancellation,
  })

  // Lazy because it is O(N^2): every one of the N levels snapshots the whole
  // partition, so it is ~9M index cells at N=3000 — dwarfing the tree itself,
  // and wasted on the many callers that only want `tree` and `order`.
  // Bound to numSamples/merges rather than to `data` and `result`, so the
  // returned object doesn't pin the input matrix for its lifetime.
  const numSamples = data.length
  const { merges } = result
  let cached: number[][][] | undefined
  return {
    tree: result.tree,
    order: result.order,
    get clustersGivenK() {
      cached ??= buildClustersGivenK(numSamples, merges)
      return cached
    },
  }
}

// mergeA[i] and mergeB[i] are stable slot indices; slot mergeA[i] absorbs
// mergeB[i]. Snapshots run from N clusters down to 1, so the result is
// reversed to put clustersGivenK[k] at k+1 clusters.
function buildClustersGivenK(numSamples: number, merges: [number, number][]) {
  const clustersGivenK: number[][][] = []
  const membership: number[][] = Array.from({ length: numSamples }, (_, i) => [
    i,
  ])
  const activeSlots = new Set<number>()
  for (let i = 0; i < numSamples; i++) {
    activeSlots.add(i)
  }

  for (let i = 0; i < numSamples - 1; i++) {
    const [a, b] = merges[i]!

    const snapshot: number[][] = []
    for (const id of activeSlots) {
      snapshot.push([...membership[id]!])
    }
    clustersGivenK.push(snapshot)

    for (const m of membership[b]!) {
      membership[a]!.push(m)
    }
    activeSlots.delete(b)
  }

  const finalSnapshot: number[][] = []
  for (const id of activeSlots) {
    finalSnapshot.push([...membership[id]!])
  }
  clustersGivenK.push(finalSnapshot)

  return clustersGivenK.reverse()
}

export async function clusterObject({
  data,
  onProgress,
  checkCancellation,
}: ClusterObjectOptions) {
  const sampleLabels = Object.keys(data)
  return clusterData({
    data: Object.values(data),
    sampleLabels,
    onProgress,
    checkCancellation,
  })
}
