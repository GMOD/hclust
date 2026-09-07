# @gmod/hclust

Fast hierarchical clustering (UPGMA) compiled to WebAssembly with
JavaScript/TypeScript bindings.

## Install

```sh
npm install @gmod/hclust
```

## Algorithm

Agglomerative clustering with average linkage. Computes Euclidean distances,
then merges the closest clusters at each step until one cluster remains,
producing a dendrogram. Equivalent to R's `hclust(method="average")`.

Roughly O(N²) in time and memory: 3,000 samples cluster in ~0.3s and 10,000 in
~5.5s. Input with many tied distances is much slower, since a tie forces a
rescan for a new nearest neighbour: 3,202 rows carrying only 9 distinct values
took 27s where 3,202 distinct rows took 0.36s. The wasm heap is 2GB and holds
the N×V input beside the N×N distance matrix (400MB at N=10,000), so a matrix
the two cannot share is refused up front with both sizes in the message. See
[docs/optimizations.md](docs/optimizations.md) for how this got fast.

## Usage

```typescript
import { clusterObject, toNewick, fromNewick } from '@gmod/hclust'

const result = await clusterObject({
  data: {
    'Sample A': [1.0, 2.0, 3.0],
    'Sample B': [1.5, 2.5, 3.5],
    'Sample C': [10.0, 11.0, 12.0],
  },
})

const newick = toNewick(result.tree)
const tree = fromNewick(newick)
```

`clusterData` is also available if you have separate arrays:

```typescript
import { clusterData } from '@gmod/hclust'

const result = await clusterData({
  data: [
    [1.0, 2.0, 3.0],
    [1.5, 2.5, 3.5],
    [10.0, 11.0, 12.0],
  ],
  sampleLabels: ['Sample A', 'Sample B', 'Sample C'],
})
```

Rows may be plain arrays or typed arrays — anything `ArrayLike<number>`.

## Result

- `tree: ClusterNode` — root of the dendrogram. Leaves have `height` 0 and no
  `children`.
- `order: number[]` — sample indices in left-to-right leaf order.
- `clustersGivenK: number[][][]` — `clustersGivenK[k]` is the partition into
  `k+1` clusters, each cluster an array of sample indices. It holds every level
  at once, so it costs O(N²) memory (~330MB at N=3000) and builds on first
  access rather than up front. Leave it alone if you only need `tree` and
  `order`.

## Input

- At least 2 samples, or `clusterData` throws.
- Every row the same length as the first, or `clusterData` throws naming the
  row.
- No `NaN` or `Infinity`, or `clusterData` throws.
- N×V×4 + N²×4 bytes within the 2GB wasm heap, or `clusterData` throws before
  allocating anything.
- Without `sampleLabels`, leaves come back as `Sample 0`, `Sample 1`, …

## Precomputed distances

Pass `distances` instead of `data` to cluster a matrix built elsewhere — on a
GPU, or under another metric:

```typescript
const result = await clusterData({
  distances, // Float32Array, N×N row-major
  sampleLabels,
})
```

Only the upper triangle (column > row) is read, so a producer may leave the
diagonal and the lower half unset. The run skips the distance phase and goes
straight to the merge loop, so `onProgress` reports only `init` and
`clustering`. A matrix that is not square, or holds a `NaN` or `Infinity`,
throws. It is clustered in place rather than beside a matrix computed here, so
the heap budget is N²×4 bytes alone.

## Other exports

- `toNewick(node)` / `fromNewick(string)` — Newick serialization, writing merge
  heights as `:` branch lengths (`(A:1.5,B:1.5)`). `fromNewick` reads that back
  into absolute heights, and still accepts the label form v4 wrote
  (`(A,B)1.5000`). See [docs/newick.md](docs/newick.md).
- `quoteName(name)` — the Newick quoting rule `toNewick` uses, exported so a
  caller writing its own Newick escapes names the same way `fromNewick` expects.
- `treeToJSON(node)` — plain-object copy of a tree, dropping empty `children`.
- `printTree(node)` — ASCII dendrogram, for debugging.

## Progress

Pass `onProgress` to observe a run. Reports arrive at most once per 100ms, so a
small run may only ever emit the `init` phase:

```typescript
clusterData({
  data,
  onProgress: ({ phase, message, current, total }) => {
    // phase: 'init' | 'distance' | 'clustering'
    // 'init' carries no denominator (total === 0) — render it indeterminate
    const label = total
      ? `${message}: ${Math.round((current / total) * 100)}%`
      : message
    console.log(label)
  },
})
```

`message` is an unformatted phase label and `current`/`total` are raw counts, so
a caller can drive a determinate progress bar off them.

## Cancellation

Pass `checkCancellation: () => void` to throw and cancel:

```typescript
clusterData({
  data,
  checkCancellation: () => {
    if (shouldCancel) throw new Error('cancelled')
  },
})
```

The run calls it on the same 100ms tick as `onProgress`, so cancellation lands
within about 100ms — and a run short enough to never report progress never
checks at all. See [docs/cancellation.md](docs/cancellation.md) for cancelling
from a web worker.

## References

- **UPGMA**: Sokal, R.R. & Michener, C.D. (1958).
- **Lance-Williams recurrence**: Lance, G.N. & Williams, W.T. (1967).
- **Newick format**: Olsen, G.J. (1990).
  http://evolution.genetics.washington.edu/phylip/newicktree.html

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
