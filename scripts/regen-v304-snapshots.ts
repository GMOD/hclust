// Regenerates test/v304-snapshots.json from @gmod/hclust@3.0.4 output.
// Manual / one-off — not part of CI. To run:
//   pnpm add -D hclust-v304@npm:@gmod/hclust@3.0.4
//   node --experimental-strip-types scripts/regen-v304-snapshots.ts > test/v304-snapshots.json
//   pnpm remove hclust-v304
import { writeFileSync } from 'node:fs'

// @ts-expect-error - alias only present when manually regenerating
import { clusterData as clusterDataV304 } from 'hclust-v304'

import { datasets } from '../test/v304-datasets.ts'

import type { ClusterNode } from '../src/types.ts'

function depth(n: ClusterNode): number {
  return n.children ? 1 + Math.max(...n.children.map(depth)) : 0
}
function leafCount(n: ClusterNode): number {
  return n.children ? n.children.reduce((s, c) => s + leafCount(c), 0) : 1
}
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

const out: Record<string, unknown> = {}
for (const { name, data } of datasets) {
  const r = await clusterDataV304({ data })
  const tree = r.tree as ClusterNode
  const partitions: Record<string, string> = {}
  const maxK = Math.min(5, data.length - 1)
  for (let k = 2; k <= maxK; k++) {
    partitions[`k${k}`] = canonPartitions(r.clustersGivenK[k]!)
  }
  out[name] = {
    depth: depth(tree),
    lopsidedness: lopsidedness(tree),
    sortedHeights: collectHeights(tree, [])
      .sort((a, b) => a - b)
      .map(h => +h.toFixed(6)),
    partitions,
  }
}
writeFileSync(1, JSON.stringify(out, null, 2) + '\n')
