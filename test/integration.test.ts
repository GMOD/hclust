import { describe, expect, it } from 'vitest'

import { clusterData, clusterObject } from '../src/cluster.ts'

import type { ClusterProgress } from '../src/types.ts'

function sortedClusters(clusters: number[][]) {
  return clusters
    .map(c => [...c].sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!)
}

describe('clusterData integration', () => {
  it('clusters 2 samples correctly', async () => {
    const data = [[1], [3]]
    const result = await clusterData({ data })

    expect(result.tree.height).toBeCloseTo(2.0)
    expect(result.tree.children).toHaveLength(2)

    expect(result.order).toEqual([0, 1])

    expect(result.clustersGivenK).toHaveLength(2)
    expect(sortedClusters(result.clustersGivenK[0]!)).toEqual([[0, 1]])
    expect(sortedClusters(result.clustersGivenK[1]!)).toEqual([[0], [1]])
  })

  it('clusters 4 samples into correct groups', async () => {
    // [1,2] should cluster together, [5,7] should cluster together
    const data = [[1], [2], [5], [7]]
    const result = await clusterData({ data })

    // Root height should be average of all pairwise distances between the two merged groups
    // d(0,2)=4, d(0,3)=6, d(1,2)=3, d(1,3)=5 → avg = 18/4 = 4.5
    expect(result.tree.height).toBeCloseTo(4.5)
    expect(result.tree.children).toHaveLength(2)

    const childHeights = result.tree
      .children!.map(c => c.height)
      .sort((a, b) => a - b)
    expect(childHeights[0]).toBeCloseTo(1.0) // d(sample0, sample1)
    expect(childHeights[1]).toBeCloseTo(2.0) // d(sample2, sample3)

    expect(result.order).toEqual([0, 1, 2, 3])

    expect(result.clustersGivenK).toHaveLength(4)
    expect(sortedClusters(result.clustersGivenK[0]!)).toEqual([[0, 1, 2, 3]])
    expect(sortedClusters(result.clustersGivenK[1]!)).toEqual([
      [0, 1],
      [2, 3],
    ])
    expect(sortedClusters(result.clustersGivenK[3]!)).toEqual([
      [0],
      [1],
      [2],
      [3],
    ])
  })

  it('clusters 4 samples in 2D correctly', async () => {
    // Two tight groups far apart
    const data = [
      [0, 0],
      [1, 0],
      [10, 0],
      [11, 0],
    ]
    const result = await clusterData({ data })

    expect(result.tree.height).toBeGreaterThan(5)
    expect(sortedClusters(result.clustersGivenK[1]!)).toEqual([
      [0, 1],
      [2, 3],
    ])
  })

  it('rejects fewer than 2 samples', async () => {
    await expect(clusterData({ data: [[1, 2, 3]] })).rejects.toThrow(
      'at least 2 samples',
    )
  })

  it('includes K=3 partition in clustersGivenK for 4 samples', async () => {
    // After first merge {0,1}, before second merge {2,3}, K=3 = {0,1}, {2}, {3}
    const data = [[1], [2], [5], [7]]
    const result = await clusterData({ data })

    expect(sortedClusters(result.clustersGivenK[2]!)).toEqual([
      [0, 1],
      [2],
      [3],
    ])
  })

  it('order is a valid permutation of sample indices', async () => {
    const data = [
      [1, 2],
      [3, 4],
      [5, 1],
      [2, 8],
    ]
    const result = await clusterData({ data })

    expect([...result.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  it('fires progress callbacks during real clustering', async () => {
    const data = Array.from({ length: 10 }, (_, i) => [i])
    const progress: ClusterProgress[] = []

    await clusterData({ data, onProgress: p => progress.push(p) })

    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]).toEqual({
      phase: 'init',
      message: 'Running hierarchical clustering in WASM',
      current: 0,
      total: 0,
    })
  })

  // the C side throttles to one progress callback per 100ms, so a small run can
  // legitimately emit nothing past 'init' — assert the invariant on whatever
  // does arrive rather than requiring any. The phase-to-report mapping itself is
  // covered deterministically in wasm-wrapper.test.ts.
  it('never reports a determinate phase without a usable denominator', async () => {
    const data = Array.from({ length: 40 }, (_, i) => [i, i * 2])
    const progress: ClusterProgress[] = []

    await clusterData({ data, onProgress: p => progress.push(p) })

    for (const p of progress.filter(p => p.phase !== 'init')) {
      expect(p.total).toBeGreaterThan(0)
      expect(p.current).toBeGreaterThanOrEqual(0)
      expect(p.current).toBeLessThanOrEqual(p.total)
      expect(p.message).not.toMatch(/%/)
    }
  })

  it('handles equal distances deterministically', async () => {
    // Sample 1 and 2 are both distance 1 from sample 0 — ties should resolve consistently
    const data = [
      [0, 0],
      [1, 0],
      [0, 1],
    ]
    const result1 = await clusterData({ data })
    const result2 = await clusterData({ data })

    expect(result1.order).toEqual(result2.order)
    expect(result1.clustersGivenK).toEqual(result2.clustersGivenK)
  })

  it('clusterObject propagates labels to leaf nodes', async () => {
    const result = await clusterObject({
      data: { alpha: [1, 2], beta: [1, 3], gamma: [9, 9] },
    })

    const leafNames = (node: {
      name: string
      children?: (typeof node)[]
    }): string[] =>
      node.children ? node.children.flatMap(leafNames) : [node.name]

    expect(leafNames(result.tree).sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns deterministic results for the same input', async () => {
    const data = [
      [1, 2],
      [3, 4],
      [5, 1],
      [2, 8],
    ]
    const result1 = await clusterData({ data })
    const result2 = await clusterData({ data })

    expect(result1.tree.height).toBe(result2.tree.height)
    expect(result1.order).toEqual(result2.order)
    expect(result1.clustersGivenK).toEqual(result2.clustersGivenK)
  })

  describe('distances', () => {
    // 0/1/2 dosages: every squared difference sums exactly in float32, so the
    // matrix computed here is bit-identical to the one the wasm builds, and
    // the two runs must agree on every merge.
    function dosages(n: number, v: number) {
      let seed = 7
      return Array.from({ length: n }, () =>
        Float32Array.from({ length: v }, () => {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return seed % 3
        }),
      )
    }

    function euclidean(data: Float32Array[]) {
      const n = data.length
      const out = new Float32Array(n * n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let sum = 0
          for (let k = 0; k < data[i]!.length; k++) {
            const d = data[i]![k]! - data[j]![k]!
            sum += d * d
          }
          out[i * n + j] = Math.sqrt(sum)
        }
      }
      return out
    }

    it('clusters a precomputed matrix to the tree the rows give', async () => {
      const data = dosages(60, 40)
      const fromRows = await clusterData({ data })
      const fromMatrix = await clusterData({ distances: euclidean(data) })
      expect(fromMatrix.tree).toEqual(fromRows.tree)
      expect(fromMatrix.order).toEqual(fromRows.order)
      expect(fromMatrix.clustersGivenK).toEqual(fromRows.clustersGivenK)
    })

    it('reads only the upper triangle', async () => {
      const upper = new Float32Array([0, 1, 5, 0, 0, 4, 0, 0, 0])
      const full = new Float32Array([0, 1, 5, 1, 0, 4, 5, 4, 0])
      const a = await clusterData({ distances: upper })
      const b = await clusterData({ distances: full })
      expect(a.tree).toEqual(b.tree)
      expect(a.tree.height).toBeCloseTo(4.5)
    })

    it('takes any metric, not only Euclidean', async () => {
      const result = await clusterData({
        distances: new Float32Array([0, 0.2, 0.9, 0, 0, 0.8, 0, 0, 0]),
        sampleLabels: ['a', 'b', 'c'],
      })
      expect(result.order).toEqual([2, 0, 1])
      expect(result.tree.height).toBeCloseTo(0.85)
    })

    it('labels leaves and reports only the clustering phase', async () => {
      const progress: ClusterProgress[] = []
      const n = 300
      const distances = new Float32Array(n * n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          distances[i * n + j] = j - i
        }
      }
      const result = await clusterData({
        distances,
        sampleLabels: Array.from({ length: n }, (_, i) => `s${i}`),
        onProgress: p => progress.push(p),
      })
      expect(result.tree.children).toHaveLength(2)
      expect(new Set(progress.map(p => p.phase))).not.toContain('distance')
    })

    it('rejects a matrix that is not square', async () => {
      await expect(
        clusterData({ distances: new Float32Array(6) }),
      ).rejects.toThrow('must be square, got 6 entries')
    })

    it('rejects fewer than 2 samples', async () => {
      await expect(
        clusterData({ distances: new Float32Array(1) }),
      ).rejects.toThrow('at least 2 samples')
    })

    it('rejects a non-finite distance', async () => {
      await expect(
        clusterData({ distances: new Float32Array([0, NaN, 0, 0]) }),
      ).rejects.toThrow('non-finite')
    })
  })
})
