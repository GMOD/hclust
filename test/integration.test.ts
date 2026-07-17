import { describe, expect, it } from 'vitest'

import { clusterData, clusterObject } from '../src/cluster.js'

import type { ClusterProgress } from '../src/types.js'

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
})
