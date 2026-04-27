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
  onProgress?.('Running hierarchical clustering in WASM...')

  const result = await hierarchicalClusterWasm({
    data,
    sampleLabels,
    statusCallback: onProgress,
    checkCancellation,
  })

  // Build clustersGivenK from stable-slot merge sequence.
  // mergeA[i] and mergeB[i] are stable slot indices; slot mergeA[i] absorbs mergeB[i].
  const numSamples = data.length
  const clustersGivenK: number[][][] = [[]]

  const membership = Array.from(
    { length: numSamples },
    (_, i) => [i] as number[],
  )
  const activeSlots = new Set(Array.from({ length: numSamples }, (_, i) => i))

  for (let i = 0; i < numSamples - 1; i++) {
    const [a, b] = result.merges[i]!

    clustersGivenK.push([...activeSlots].map(id => [...membership[id]!]))

    membership[a] = [...membership[a]!, ...membership[b]!]
    activeSlots.delete(b)
  }

  clustersGivenK.push([...activeSlots].map(id => [...membership[id]!]))

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
