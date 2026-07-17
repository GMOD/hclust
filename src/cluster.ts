import { hierarchicalClusterWasm } from './wasm-wrapper.js'

import type {
  ClusterObjectOptions,
  ClusterOptions,
  ClusterResult,
} from './types.js'

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

  // Build clustersGivenK from stable-slot merge sequence.
  // mergeA[i] and mergeB[i] are stable slot indices; slot mergeA[i] absorbs mergeB[i].
  // clustersGivenK[k] = cluster partitions when there are k+1 clusters (k=0..N-1).
  const numSamples = data.length
  const clustersGivenK: number[][][] = []

  const membership: number[][] = Array.from({ length: numSamples }, (_, i) => [
    i,
  ])
  const activeSlots = new Set<number>()
  for (let i = 0; i < numSamples; i++) {
    activeSlots.add(i)
  }

  for (let i = 0; i < numSamples - 1; i++) {
    const [a, b] = result.merges[i]!

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

  return {
    tree: result.tree,
    order: result.order,
    clustersGivenK: clustersGivenK.reverse(),
  }
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
