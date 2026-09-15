interface ClusteringModule {
  HEAPF32: Float32Array
  HEAP32: Int32Array
  _clusterBeginRows: (numSamples: number, vectorSize: number) => number
  _clusterBeginMatrix: (numSamples: number) => number
  _clusterInput: (run: number) => number
  _clusterStep: (run: number, budgetMs: number) => number
  _clusterProgress: (run: number) => number
  _clusterMerges: (run: number) => number
  _clusterFree: (run: number) => void
}

export default function createClusteringModule(): Promise<ClusteringModule>
