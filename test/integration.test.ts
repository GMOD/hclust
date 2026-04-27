import { describe, expect, it } from 'vitest'

import { clusterData } from '../src/cluster.js'

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

    expect(result.clustersGivenK).toHaveLength(3)
    expect(sortedClusters(result.clustersGivenK[0]!)).toEqual([[0, 1]])
    expect(sortedClusters(result.clustersGivenK[1]!)).toEqual([[0], [1]])
    expect(result.clustersGivenK[2]).toEqual([])
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

    expect(result.clustersGivenK).toHaveLength(5)
    expect(result.clustersGivenK[4]).toEqual([])
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
