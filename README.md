# @gmod/hclust

Fast hierarchical clustering (UPGMA) compiled to WebAssembly with
JavaScript/TypeScript bindings.

## Algorithm

Agglomerative clustering with average linkage. Computes Euclidean distances,
then merges the closest clusters at each step until one cluster remains,
producing a dendrogram. Equivalent to R's `hclust(method="average")`.

## Features

- WASM-accelerated distance matrix and clustering
- Float32 precision
- Newick/JSON serialization
- Cancellation via callback
- Web worker compatible

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
a caller can drive a determinate progress bar. Percentages are never
preformatted into `message` — append your own.

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

For web workers with cross-origin isolation, use `SharedArrayBuffer` +
`Atomics`. Without it, use blob URL + synchronous XHR (web workers only).

## References

- **UPGMA**: Sokal, R.R. & Michener, C.D. (1958).
- **Lance-Williams recurrence**: Lance, G.N. & Williams, W.T. (1967).
- **Newick format**: Olsen, G.J. (1990).
  http://evolution.genetics.washington.edu/phylip/newicktree.html

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
