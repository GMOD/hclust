import createClusteringModule from './distance.js'

import type { ClusterNode } from './types.js'

type ClusteringModule = Awaited<ReturnType<typeof createClusteringModule>>

let modulePromise: Promise<ClusteringModule> | null = null

function getModule() {
  if (!modulePromise) {
    modulePromise = createClusteringModule().catch((e: unknown) => {
      modulePromise = null
      throw e
    })
  }
  return modulePromise
}

export interface ClusteringResult {
  tree: ClusterNode
  order: number[]
  heights: Float32Array
  merges: [number, number][]
}

export interface ClusteringOptions {
  data: number[][]
  sampleLabels?: string[]
  statusCallback?: (message: string) => void
  checkCancellation?: () => void
}

export async function hierarchicalClusterWasm(
  options: ClusteringOptions,
): Promise<ClusteringResult> {
  const { data, sampleLabels, statusCallback, checkCancellation } = options
  const module = await getModule()
  const numSamples = data.length
  if (numSamples < 2) {
    throw new Error('clusterData requires at least 2 samples')
  }
  const vectorSize = data[0]?.length ?? 0

  const flatData = new Float32Array(numSamples * vectorSize)
  for (let i = 0; i < numSamples; i++) {
    flatData.set(data[i]!, i * vectorSize)
  }

  const dataPtr = module._malloc(flatData.length * 4)
  const heightsPtr = module._malloc((numSamples - 1) * 4)
  const mergeAPtr = module._malloc((numSamples - 1) * 4)
  const mergeBPtr = module._malloc((numSamples - 1) * 4)

  let callbackPtr: number | null = null

  try {
    module.HEAPF32.set(flatData, dataPtr / 4)

    if (statusCallback || checkCancellation) {
      const progressCallback = (iteration: number, totalIterations: number) => {
        checkCancellation?.()
        if (statusCallback) {
          if (iteration < 0) {
            const distancesDone = -iteration
            const progress = Math.round((distancesDone / totalIterations) * 100)
            statusCallback(`Computing distance matrix: ${progress}%`)
          } else {
            const progress = Math.round((iteration / totalIterations) * 100)
            statusCallback(`Clustering samples: ${progress}%`)
          }
        }
        return 1
      }

      callbackPtr = module.addFunction(progressCallback, 'iii')
      module._setProgressCallback(callbackPtr)
    }

    const result = module._hierarchicalCluster(
      dataPtr,
      numSamples,
      vectorSize,
      heightsPtr,
      mergeAPtr,
      mergeBPtr,
    )

    if (result === -1) {
      throw new Error('aborted')
    }
    if (result === -2) {
      throw new Error('input contains non-finite values (NaN or Infinity)')
    }

    const heights = new Float32Array(numSamples - 1)
    heights.set(
      module.HEAPF32.subarray(heightsPtr / 4, heightsPtr / 4 + numSamples - 1),
    )

    const mergeA = new Int32Array(numSamples - 1)
    mergeA.set(
      module.HEAP32.subarray(mergeAPtr / 4, mergeAPtr / 4 + numSamples - 1),
    )

    const mergeB = new Int32Array(numSamples - 1)
    mergeB.set(
      module.HEAP32.subarray(mergeBPtr / 4, mergeBPtr / 4 + numSamples - 1),
    )

    const { tree, leafOrder } = rebuildTree(
      numSamples,
      heights,
      mergeA,
      mergeB,
      sampleLabels,
    )
    const merges: [number, number][] = []
    for (let i = 0; i < numSamples - 1; i++) {
      merges.push([mergeA[i]!, mergeB[i]!])
    }

    return {
      tree,
      order: leafOrder,
      heights,
      merges,
    }
  } finally {
    if (callbackPtr !== null) {
      module.removeFunction(callbackPtr)
      module._setProgressCallback(0)
    }

    module._free(dataPtr)
    module._free(heightsPtr)
    module._free(mergeAPtr)
    module._free(mergeBPtr)
  }
}

// Rebuilds the tree from stable slot indices (mergeA[i] < mergeB[i] always).
// Slot mergeA[i] absorbs mergeB[i] each iteration, so nodes[0] is always the root.
// At every merge the smaller subtree is placed on the left so the dendrogram is
// balanced visually rather than degenerating into a caterpillar when slot 0
// keeps absorbing. leafOrder is the left-to-right leaf sequence of that tree.
function rebuildTree(
  numSamples: number,
  heights: Float32Array,
  mergeA: Int32Array,
  mergeB: Int32Array,
  sampleLabels?: string[],
) {
  const nodes: ClusterNode[] = new Array(numSamples)
  const leaves: number[][] = new Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    nodes[i] = { name: sampleLabels?.[i] ?? `Sample ${i}`, height: 0 }
    leaves[i] = [i]
  }
  for (let i = 0; i < numSamples - 1; i++) {
    const dst = mergeA[i]!
    let small = dst
    let large = mergeB[i]!
    if (leaves[small]!.length > leaves[large]!.length) {
      small = mergeB[i]!
      large = dst
    }
    nodes[dst] = {
      name: `Cluster ${i}`,
      height: heights[i]!,
      children: [nodes[small]!, nodes[large]!],
    }
    leaves[dst] = leaves[small]!.concat(leaves[large]!)
  }
  return { tree: nodes[0]!, leafOrder: leaves[0]! }
}
