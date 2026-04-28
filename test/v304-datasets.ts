// Deterministic test datasets shared by v3.0.4 snapshot regeneration and
// the live v3.0.4 compatibility tests. Pure data definitions only.

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
      for (let j = 0; j < W; j++) {
        if (r() < 0.2) {
          row[j] = Math.floor(r() * 4)
        }
      }
    }
    return row
  })
}

export const datasets: { name: string; data: number[][] }[] = [
  { name: 'gaussian-20', data: gaussian2D(20, 42) },
  { name: 'gaussian-40', data: gaussian2D(40, 7) },
  { name: 'three-clusters-30', data: clusters3(30, 99) },
  { name: 'three-clusters-60', data: clusters3(60, 1) },
  { name: 'sparse-duplicates-100', data: sparseDuplicates(100, 5) },
  { name: 'sparse-duplicates-200', data: sparseDuplicates(200, 11) },
]
