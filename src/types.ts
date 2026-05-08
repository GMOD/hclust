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

export interface ClusterOptions {
  data: NumericVector[]
  sampleLabels?: string[]
  onProgress?: (message: string) => void
  checkCancellation?: () => void
}

export interface ClusterObjectOptions {
  data: Record<string, NumericVector>
  onProgress?: (message: string) => void
  checkCancellation?: () => void
}
