import { checkStopToken } from './stopToken.js'
import { hierarchicalClusterWasm } from './wasm-wrapper.js'

import type { ClusterOptions, ClusterResult } from './types.js'

export async function clusterData({
  data,
  sampleLabels,
  onProgress,
  stopToken,
  checkCancellation,
}: ClusterOptions): Promise<ClusterResult> {
  onProgress?.('Running hierarchical clustering in WASM...')

  // Prefer the callback; fall back to legacy stopToken-based XHR check
  const cancellationCheck =
    checkCancellation ??
    (stopToken
      ? () => {
          try {
            checkStopToken(stopToken)
            return false
          } catch {
            return true
          }
        }
      : undefined)

  const result = await hierarchicalClusterWasm({
    data,
    sampleLabels,
    statusCallback: onProgress,
    checkCancellation: cancellationCheck,
  })

  // Build clustersGivenK from merge information
  const numSamples = data.length
  const clustersGivenK: number[][][] = [[]]

  // Start with each sample in its own cluster
  const clusterSets: number[][] = Array.from({ length: numSamples }, (_, i) => [
    i,
  ])

  for (let i = 0; i < numSamples - 1; i++) {
    const [mergeA, mergeB] = result.merges[i]!

    // Record current state
    clustersGivenK.push(clusterSets.map(s => [...s]))

    // Merge clusters
    const newCluster = [...clusterSets[mergeA]!, ...clusterSets[mergeB]!]

    const removeFirst = Math.max(mergeA, mergeB)
    const removeSecond = Math.min(mergeA, mergeB)

    clusterSets.splice(removeFirst, 1)
    clusterSets.splice(removeSecond, 1)
    clusterSets.push(newCluster)
  }

  clustersGivenK.push(clusterSets.map(s => [...s]))

  // Create a dummy distance matrix (not used by caller, but part of interface)
  const distances = new Float32Array(numSamples * numSamples)

  return {
    tree: result.tree,
    distances,
    order: result.order,
    clustersGivenK: clustersGivenK.reverse(),
  }
}
