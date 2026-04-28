// Regression tests against v3.0.4 published to npm (aliased as hclust-v304).
// Guards against future changes that would visually alter dendrogram shape.
// @ts-expect-error - package alias has no bundled types we need
import { clusterData as clusterDataV304 } from 'hclust-v304'
import { describe, expect, it } from 'vitest'

import { clusterData } from '../src/cluster.js'

import type { ClusterNode } from '../src/types.js'

function seededRand(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function gaussian2D(n: number, seed: number) {
  const r = seededRand(seed)
  return Array.from({ length: n }, () => [r() * 10 - 5, r() * 10 - 5])
}

function clusters3(n: number, seed: number) {
  const r = seededRand(seed)
  const centers = [
    [0, 0],
    [10, 0],
    [5, 8],
  ]
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % 3]!
    return [c[0]! + r() * 1.5, c[1]! + r() * 1.5]
  })
}

// Sparse rows with many duplicates — mimics BigWig coverage / variant-density
// vectors where most cells are zero and many rows are identical. This pattern
// produces many tied pairwise distances and exposed the find-min tie-breaking
// bug that turned the dendrogram into a chain.
function sparseDuplicates(n: number, seed: number) {
  const r = seededRand(seed)
  const W = 100
  return Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(W).fill(0)
    if (i >= n * 0.8) {
      for (let j = 0; j < W; j++) {if (r() < 0.2) {row[j] = Math.floor(r() * 4)}}
    }
    return row
  })
}

function depth(n: ClusterNode): number {
  return n.children ? 1 + Math.max(...n.children.map(depth)) : 0
}

function leafCount(n: ClusterNode): number {
  return n.children ? n.children.reduce((s, c) => s + leafCount(c), 0) : 1
}

// Sum of |leftLeaves - rightLeaves| across internal nodes.
// Caterpillar = O(n²); balanced = O(n).
function lopsidedness(n: ClusterNode): number {
  if (!n.children || n.children.length < 2) {return 0}
  const counts = n.children.map(leafCount)
  return (
    Math.abs(counts[0]! - counts[1]!) +
    n.children.reduce((s, c) => s + lopsidedness(c), 0)
  )
}

const datasets: { name: string; data: number[][] }[] = [
  { name: 'gaussian-20', data: gaussian2D(20, 42) },
  { name: 'gaussian-40', data: gaussian2D(40, 7) },
  { name: 'three-clusters-30', data: clusters3(30, 99) },
  { name: 'three-clusters-60', data: clusters3(60, 1) },
  { name: 'sparse-duplicates-100', data: sparseDuplicates(100, 5) },
  { name: 'sparse-duplicates-200', data: sparseDuplicates(200, 11) },
]

describe('v3.0.4 compatibility', () => {
  for (const { name, data } of datasets) {
    it(`${name}: merge heights match v3.0.4 within float tolerance`, async () => {
      const ours = await clusterData({ data })
      const ref = await clusterDataV304({ data })

      const collect = (n: ClusterNode, out: number[]): number[] => {
        if (n.children) {
          out.push(n.height)
          for (const c of n.children) {collect(c, out)}
        }
        return out
      }
      const oursHeights = collect(ours.tree, []).sort((a, b) => a - b)
      const refHeights = collect(ref.tree, []).sort((a, b) => a - b)
      expect(oursHeights.length).toBe(refHeights.length)
      for (let i = 0; i < oursHeights.length; i++) {
        expect(oursHeights[i]).toBeCloseTo(refHeights[i]!, 3)
      }
    })

    it(`${name}: dendrogram shape stays close to v3.0.4`, async () => {
      const ours = await clusterData({ data })
      const ref = await clusterDataV304({ data })

      const oursDepth = depth(ours.tree)
      const refDepth = depth(ref.tree)
      const oursLop = lopsidedness(ours.tree)
      const refLop = lopsidedness(ref.tree)

      // Within 30% of v3.0.4's metrics — guards against caterpillar regression
      // without requiring exact-match (last-bit ties resolve differently).
      expect(oursDepth).toBeLessThanOrEqual(Math.max(refDepth + 2, refDepth * 1.3))
      expect(oursLop).toBeLessThanOrEqual(Math.max(refLop + 5, refLop * 1.5))
    })

    it(`${name}: clustersGivenK partitions match v3.0.4`, async () => {
      const ours = await clusterData({ data })
      const ref = await clusterDataV304({ data })

      const canon = (clusters: number[][]) =>
        clusters
          .map(c => [...c].sort((a, b) => a - b).join(','))
          .sort()
          .join('|')

      // Compare partitions at K=2..min(5, n-1) — coarse structure should agree
      const maxK = Math.min(5, data.length - 1)
      for (let k = 2; k <= maxK; k++) {
        expect(canon(ours.clustersGivenK[k]!)).toBe(canon(ref.clustersGivenK[k]!))
      }
    })
  }
})
