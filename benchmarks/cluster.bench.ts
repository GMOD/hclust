// Clustering benchmarks, against src/ rather than a built branch.
//
// The `onProgress` cases are the point of this file. Passing a progress
// callback registers one into the wasm module and changes which code the hot
// loop runs, and every benchmark written before this one omitted it — so a
// change that made the callback path 2.5x slower than the bare path measured
// clean and shipped (ac57be9). JBrowse always passes onProgress. Benchmark the
// configuration the caller actually uses, not the default arguments.
//
// The tied case matters for the same reason: cached-neighbour invalidation
// makes duplicate-heavy input a different performance regime from continuous
// input, and only one of the two is exercised by random data.
//
// Run with `pnpm bench`.
import { bench, describe } from 'vitest'

import { clusterData } from '../src/index.ts'

const V = 20

// Distinct distances throughout: the cached nearest neighbour of a cluster is
// rarely invalidated, so this is the fast regime.
function continuous(n: number) {
  return Array.from({ length: n }, (_, i) =>
    Float32Array.from({ length: V }, (_, j) => Math.sin(i * 31 + j * 7) * 100),
  )
}

// Sparse rows with many exact duplicates — BigWig coverage vectors, variant
// densities. Ties force repeated nearest-neighbour rescans.
function tied(n: number) {
  return Array.from({ length: n }, (_, i) =>
    Float32Array.from({ length: V }, (_, j) =>
      i % 4 === 0 ? 0 : (i % 7) * 3 + (j % 5),
    ),
  )
}

const opts = { iterations: 5, warmupIterations: 2 }

for (const n of [500, 1500]) {
  describe(`continuous n=${n}`, () => {
    const data = continuous(n)
    bench(
      'no callbacks',
      async () => {
        await clusterData({ data })
      },
      opts,
    )
    bench(
      'onProgress',
      async () => {
        await clusterData({ data, onProgress: () => {} })
      },
      opts,
    )
  })

  describe(`tied n=${n}`, () => {
    const data = tied(n)
    bench(
      'no callbacks',
      async () => {
        await clusterData({ data })
      },
      opts,
    )
    bench(
      'onProgress',
      async () => {
        await clusterData({ data, onProgress: () => {} })
      },
      opts,
    )
  })
}

// clustersGivenK is a lazy getter and costs O(n^2) to build (d51749e). Callers
// that only want the tree never pay it; this is what they would pay if they
// touched it.
describe('clustersGivenK n=1500', () => {
  const data = continuous(1500)
  bench(
    'tree only',
    async () => {
      const r = await clusterData({ data })
      void r.tree
    },
    opts,
  )
  bench(
    'clustersGivenK accessed',
    async () => {
      const r = await clusterData({ data })
      void r.clustersGivenK
    },
    opts,
  )
})
