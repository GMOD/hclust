export interface ClusterNode {
  name: string
  height: number
  children?: ClusterNode[]
}

export interface ClusterResult {
  tree: ClusterNode
  order: number[]
  clustersGivenK: number[][][]
}

// A row vector. Accepts plain arrays, typed arrays, or anything else with a
// numeric length and indexed numeric entries — the WASM bridge copies via
// Float32Array.set which handles all of these uniformly.
export type NumericVector = ArrayLike<number>

/**
 * A progress report from a run. `current`/`total` are raw counts rather than a
 * preformatted percentage so callers can drive a determinate progress bar; they
 * are both 0 for the 'init' phase, which has no meaningful denominator and
 * should render as indeterminate. `message` is an unformatted phase label — it
 * carries no percentage, so append one from `current`/`total` if you want it.
 */
export interface ClusterProgress {
  phase: 'init' | 'distance' | 'clustering'
  message: string
  current: number
  total: number
}

interface ClusterCommonOptions {
  sampleLabels?: string[]
  onProgress?: (progress: ClusterProgress) => void
  checkCancellation?: () => void
}

export interface ClusterDataOptions extends ClusterCommonOptions {
  /** One row per sample; the Euclidean distance between rows is clustered. */
  data: NumericVector[]
  distances?: undefined
}

export interface ClusterDistancesOptions extends ClusterCommonOptions {
  data?: undefined
  /**
   * A precomputed N×N row-major distance matrix, any metric. Only the upper
   * triangle (column > row) is read, so a producer may leave the rest unset.
   * The run skips the distance phase, so `onProgress` sees only 'init' and
   * 'clustering'.
   */
  distances: Float32Array
}

export type ClusterOptions = ClusterDataOptions | ClusterDistancesOptions

export interface ClusterObjectOptions {
  data: Record<string, NumericVector>
  onProgress?: (progress: ClusterProgress) => void
  checkCancellation?: () => void
}
