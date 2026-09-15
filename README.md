# @gmod/hclust

Fast hierarchical clustering (UPGMA) compiled to WebAssembly with
JavaScript/TypeScript bindings. Equivalent to R's `hclust(method="average")`
over Euclidean distances.

## Install

```sh
npm install @gmod/hclust
```

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

`clusterData` takes separate arrays. Rows may be plain or typed arrays:

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

### Options

- `sampleLabels` — leaf names; defaults to `Sample 0`, `Sample 1`, …
- `distances` — a precomputed N×N row-major `Float32Array` in place of `data`.
  Only the upper triangle is read.
- `onProgress({ phase, message, current, total })` — called at most every 100ms.
  `phase` is `'init' | 'distance' | 'clustering'`; `init` has `total === 0`.
- `signal` — an `AbortSignal`; the run rejects within about 50ms of an abort.

`clusterData` throws on fewer than 2 samples, ragged rows, `NaN`/`Infinity`, or
input too large for the 2GB wasm heap.

## Result

- `tree: ClusterNode` — root of the dendrogram. Leaves have `height` 0.
- `order: number[]` — sample indices in left-to-right leaf order.
- `clustersGivenK: number[][][]` — `clustersGivenK[k]` partitions the samples
  into `k+1` clusters. Built lazily, and O(N²) memory (~330MB at N=3000).

## Other exports

- `toNewick(node)` / `fromNewick(string)` — Newick serialization with merge
  heights as branch lengths.
- `quoteName(name)` — the name quoting `toNewick` uses.
- `treeToJSON(node)` — plain-object copy of a tree.
- `printTree(node)` — ASCII dendrogram, for debugging.

## Docs

- [docs/optimizations.md](docs/optimizations.md) — how the clustering got fast,
  benchmark results, memory limits, and the cost of tied input
- [docs/newick.md](docs/newick.md) — the Newick format `toNewick` writes, and
  reading the v4 format
- [docs/cancellation.md](docs/cancellation.md) — cancelling from a web worker,
  and how each environment yields between slices

## References

- **UPGMA**: Sokal, R.R. & Michener, C.D. (1958).
- **Lance-Williams recurrence**: Lance, G.N. & Williams, W.T. (1967).
- **Newick format**: Olsen, G.J. (1990).
  http://evolution.genetics.washington.edu/phylip/newicktree.html

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
