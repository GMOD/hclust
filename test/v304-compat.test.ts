// Regression tests against v3.0.4. Fixtures in v304-snapshots.json were
// captured from running @gmod/hclust@3.0.4 on the datasets in
// v304-datasets.ts. To regenerate, see scripts/regen-v304-snapshots.ts.
import { describe, expect, it } from 'vitest'

import { datasets } from './v304-datasets.js'
import snapshots from './v304-snapshots.json' with { type: 'json' }
import { clusterData } from '../src/cluster.js'

import type { ClusterNode } from '../src/types.js'

interface Snapshot {
  depth: number
  lopsidedness: number
  sortedHeights: number[]
  partitions: Record<string, string>
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
  if (!n.children || n.children.length < 2) {
    return 0
  }
  const counts = n.children.map(leafCount)
  return (
    Math.abs(counts[0]! - counts[1]!) +
    n.children.reduce((s, c) => s + lopsidedness(c), 0)
  )
}

function collectHeights(n: ClusterNode, out: number[]): number[] {
  if (n.children) {
    out.push(n.height)
    for (const c of n.children) {
      collectHeights(c, out)
    }
  }
  return out
}

function canonPartitions(clusters: number[][]) {
  return clusters
    .map(c => [...c].sort((a, b) => a - b).join(','))
    .sort()
    .join('|')
}

describe('v3.0.4 compatibility (snapshot fixtures)', () => {
  for (const { name, data } of datasets) {
    const ref = (snapshots as Record<string, Snapshot>)[name]!

    it(`${name}: merge heights match v3.0.4 within float tolerance`, async () => {
      const ours = await clusterData({ data })
      const oursHeights = collectHeights(ours.tree, []).sort((a, b) => a - b)
      expect(oursHeights.length).toBe(ref.sortedHeights.length)
      for (let i = 0; i < oursHeights.length; i++) {
        expect(oursHeights[i]).toBeCloseTo(ref.sortedHeights[i]!, 3)
      }
    })

    it(`${name}: dendrogram shape stays close to v3.0.4`, async () => {
      const ours = await clusterData({ data })
      // Within 30% of v3.0.4 metrics — guards against caterpillar regression
      // without requiring exact-match (last-bit ties resolve differently).
      expect(depth(ours.tree)).toBeLessThanOrEqual(
        Math.max(ref.depth + 2, ref.depth * 1.3),
      )
      expect(lopsidedness(ours.tree)).toBeLessThanOrEqual(
        Math.max(ref.lopsidedness + 5, ref.lopsidedness * 1.5),
      )
    })

    it(`${name}: clustersGivenK partitions match v3.0.4`, async () => {
      const ours = await clusterData({ data })
      const maxK = Math.min(5, data.length - 1)
      for (let k = 2; k <= maxK; k++) {
        expect(canonPartitions(ours.clustersGivenK[k]!)).toBe(
          ref.partitions[`k${k}`],
        )
      }
    })
  }
})
