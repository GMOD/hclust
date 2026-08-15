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
  `k+1` clusters, each cluster an array of sample indices.

## Input

- At least 2 samples, or `clusterData` throws.
- Every row the same length as the first, which sets the vector size. Ragged
  input is not validated: a short row is zero-padded, a long one overruns into
  the next sample.
- No `NaN` or `Infinity`, or `clusterData` throws.
- Without `sampleLabels`, leaves are named `Sample 0`, `Sample 1`, …

## Other exports

- `toNewick(node)` / `fromNewick(string)` — Newick serialization. Internal node
  height is encoded as the label (`(A,B)1.2345`); `fromNewick` also accepts
  branch-length (`:`) form.
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
a caller can drive a determinate progress bar.

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

It is called on the same 100ms tick as `onProgress`, so cancellation lands
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
