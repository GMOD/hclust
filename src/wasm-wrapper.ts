import createClusteringModule from './wasm/distance.js'

import type { ClusterNode, ClusterProgress, NumericVector } from './types.ts'

type ClusteringModule = Awaited<ReturnType<typeof createClusteringModule>>

// MAXIMUM_MEMORY in scripts/build_wasm.sh
const HEAP_MAX_BYTES = 2 ** 31

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

function clusteringHeapBytes(numSamples: number, vectorSize: number) {
  return {
    data: numSamples * vectorSize * 4,
    distances: numSamples * numSamples * 4,
    results: 3 * (numSamples - 1) * 4,
  }
}

function gigabytes(bytes: number) {
  return `${(bytes / 1e9).toFixed(2)}GB`
}

function outOfMemoryError(numSamples: number, vectorSize: number) {
  const { data, distances } = clusteringHeapBytes(numSamples, vectorSize)
  return new Error(
    `out of memory clustering ${numSamples} samples x ${vectorSize} columns: the input matrix needs ${gigabytes(data)} and the distance matrix ${gigabytes(distances)}, both inside a ${gigabytes(HEAP_MAX_BYTES)} wasm heap`,
  )
}

export interface ClusteringResult {
  tree: ClusterNode
  order: number[]
  heights: Float32Array
  merges: [number, number][]
}

export interface ClusteringOptions {
  data?: NumericVector[]
  distances?: Float32Array
  sampleLabels?: string[]
  statusCallback?: (progress: ClusterProgress) => void
  checkCancellation?: () => void
}

export async function hierarchicalClusterWasm(
  options: ClusteringOptions,
): Promise<ClusteringResult> {
  const { data, distances, sampleLabels, statusCallback, checkCancellation } =
    options
  const { numSamples, vectorSize, rows, rowStride } = describeInput(
    data,
    distances,
  )
  if (numSamples < 2) {
    throw new Error('clusterData requires at least 2 samples')
  }
  const bytes = clusteringHeapBytes(numSamples, vectorSize)
  const inputBytes = rows.length * rowStride * 4
  // a precomputed matrix is clustered in place, so it is the input allocation
  // and the distance matrix at once rather than one beside the other
  const heapNeeded = distances
    ? inputBytes + bytes.results
    : inputBytes + bytes.distances + bytes.results
  if (heapNeeded > HEAP_MAX_BYTES) {
    throw outOfMemoryError(numSamples, vectorSize)
  }

  const module = await getModule()
  const dataPtr = module._malloc(inputBytes)
  const heightsPtr = module._malloc((numSamples - 1) * 4)
  const mergeAPtr = module._malloc((numSamples - 1) * 4)
  const mergeBPtr = module._malloc((numSamples - 1) * 4)

  let callbackPtr: number | null = null

  try {
    if (!dataPtr || !heightsPtr || !mergeAPtr || !mergeBPtr) {
      throw outOfMemoryError(numSamples, vectorSize)
    }
    const heap = module.HEAPF32
    for (let i = 0; i < rows.length; i++) {
      heap.set(rows[i]!, dataPtr / 4 + i * rowStride)
    }

    if (statusCallback || checkCancellation) {
      const progressCallback = (iteration: number, totalIterations: number) => {
        checkCancellation?.()
        if (statusCallback) {
          // the C side flags the distance-matrix phase with a negative count
          statusCallback(
            iteration < 0
              ? {
                  phase: 'distance',
                  message: 'Computing distance matrix',
                  current: -iteration,
                  total: totalIterations,
                }
              : {
                  phase: 'clustering',
                  message: 'Clustering samples',
                  current: iteration,
                  total: totalIterations,
                },
          )
        }
        return 1
      }

      callbackPtr = module.addFunction(progressCallback, 'iii')
      module._setProgressCallback(callbackPtr)
    }

    const result = distances
      ? module._clusterDistanceMatrix(
          dataPtr,
          numSamples,
          heightsPtr,
          mergeAPtr,
          mergeBPtr,
        )
      : module._hierarchicalCluster(
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
    if (result === -3) {
      throw outOfMemoryError(numSamples, vectorSize)
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

// Either input goes to the wasm heap row by row, without a staging copy: the
// rows as they are, or a precomputed distance matrix as one row of N² values. A
// distance matrix is N×N by contract, so N is its square root.
function describeInput(data?: NumericVector[], distances?: Float32Array) {
  if (distances) {
    const numSamples = Math.round(Math.sqrt(distances.length))
    if (numSamples * numSamples !== distances.length) {
      throw new Error(
        `a distance matrix must be square, got ${distances.length} entries`,
      )
    }
    return {
      numSamples,
      vectorSize: 0,
      rows: [distances],
      rowStride: distances.length,
    }
  }
  if (!data) {
    throw new Error('clusterData needs either data or distances')
  }
  const vectorSize = data[0]?.length ?? 0
  for (let i = 1; i < data.length; i++) {
    const length = data[i]!.length
    if (length !== vectorSize) {
      throw new Error(`row ${i} has ${length} columns, row 0 has ${vectorSize}`)
    }
  }
  return {
    numSamples: data.length,
    vectorSize,
    rows: data,
    rowStride: vectorSize,
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
