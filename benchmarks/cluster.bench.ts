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
// The wide case is the third regime, and the one JBrowse's variant clustering
// actually runs in: one column per site in the window, thousands wide, where
// the distance build is nearly the whole run and the merge loop is noise. It
// went unmeasured through the first five optimizations because every case
// here was V = 20. `pnpm bench:real` runs the same regime on real genotypes,
// first call included.
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

// 0/1/2 dosages at a per-site allele frequency: what a diploid panel with no
// missing calls hands over.
function genotypes(n: number, v: number) {
  let s = 7
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const freqs = Float32Array.from({ length: v }, () => 0.05 + rnd() * 0.45)
  return Array.from({ length: n }, () =>
    Float32Array.from({ length: v }, (_, j) => {
      const p = freqs[j]!
      return (rnd() < p ? 1 : 0) + (rnd() < p ? 1 : 0)
    }),
  )
}

describe('wide n=500 v=3000', () => {
  const data = genotypes(500, 3000)
  bench(
    'onProgress',
    async () => {
      await clusterData({ data, onProgress: () => {} })
    },
    opts,
  )
})

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
