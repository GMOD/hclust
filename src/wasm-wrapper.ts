import createClusteringModule from './wasm/distance.js'
import { yieldToEventLoop } from './yield-task.ts'

import type { ClusterNode, ClusterProgress, NumericVector } from './types.ts'

type ClusteringModule = Awaited<ReturnType<typeof createClusteringModule>>

// MAXIMUM_MEMORY in scripts/build_wasm.sh
const HEAP_MAX_BYTES = 2 ** 31
const SLICE_MS = 50
const PROGRESS_INTERVAL_MS = 100

// STEP_* and PROGRESS_* in src/wasm/distance.c
const STEP_DONE = 0
const STEP_NON_FINITE = 2
const PROGRESS_DISTANCE = 0

let modulePromise: Promise<ClusteringModule> | null = null
let runsInFlight = 0

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

function outOfMemoryError(
  numSamples: number,
  vectorSize: number,
  otherRuns = 0,
) {
  const { data, distances } = clusteringHeapBytes(numSamples, vectorSize)
  const sharing = otherRuns
    ? `, shared with ${otherRuns} other clustering run${otherRuns > 1 ? 's' : ''} in progress`
    : ''
  return new Error(
    `out of memory clustering ${numSamples} samples x ${vectorSize} columns: the input matrix needs ${gigabytes(data)} and the distance matrix ${gigabytes(distances)}, both inside a ${gigabytes(HEAP_MAX_BYTES)} wasm heap${sharing}`,
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
  onProgress?: (progress: ClusterProgress) => void
  signal?: AbortSignal
  sliceMs?: number
}

export async function hierarchicalClusterWasm({
  data,
  distances,
  sampleLabels,
  onProgress,
  signal,
  sliceMs = SLICE_MS,
}: ClusteringOptions): Promise<ClusteringResult> {
  const input = describeInput(data, distances)
  const { numSamples, vectorSize, rows, rowStride } = input
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
  signal?.throwIfAborted()
  const module = await getModule()
  signal?.throwIfAborted()

  const { heights, mergeA, mergeB } = await runClustering(
    module,
    input,
    !!distances,
    sliceMs,
    onProgress,
    signal,
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
  return { tree, order: leafOrder, heights, merges }
}

async function runClustering(
  module: ClusteringModule,
  { numSamples, vectorSize, rows, rowStride }: ReturnType<typeof describeInput>,
  matrixInput: boolean,
  sliceMs: number,
  onProgress?: (progress: ClusterProgress) => void,
  signal?: AbortSignal,
) {
  const run = matrixInput
    ? module._clusterBeginMatrix(numSamples)
    : module._clusterBeginRows(numSamples, vectorSize)
  if (!run) {
    throw outOfMemoryError(numSamples, vectorSize, runsInFlight)
  }
  runsInFlight++
  try {
    const inputOffset = module._clusterInput(run) / 4
    for (let i = 0; i < rows.length; i++) {
      module.HEAPF32.set(rows[i]!, inputOffset + i * rowStride)
    }

    let lastReport = performance.now()
    for (;;) {
      const status = module._clusterStep(run, sliceMs)
      if (status === STEP_DONE) {
        break
      }
      if (status === STEP_NON_FINITE) {
        throw new Error('input contains non-finite values (NaN or Infinity)')
      }
      const now = performance.now()
      if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now
        onProgress(readProgress(module, run))
      }
      await yieldToEventLoop()
      signal?.throwIfAborted()
    }

    const count = numSamples - 1
    const offset = module._clusterMerges(run) / 4
    return {
      heights: module.HEAPF32.slice(offset, offset + count),
      mergeA: module.HEAP32.slice(offset + count, offset + 2 * count),
      mergeB: module.HEAP32.slice(offset + 2 * count, offset + 3 * count),
    }
  } finally {
    runsInFlight--
    module._clusterFree(run)
  }
}

function readProgress(module: ClusteringModule, run: number): ClusterProgress {
  const offset = module._clusterProgress(run) / 4
  const phase = module.HEAP32[offset]
  const current = module.HEAP32[offset + 1]!
  const total = module.HEAP32[offset + 2]!
  return phase === PROGRESS_DISTANCE
    ? {
        phase: 'distance',
        message: 'Computing distance matrix',
        current,
        total,
      }
    : { phase: 'clustering', message: 'Clustering samples', current, total }
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
