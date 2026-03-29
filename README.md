# @gmod/hclust

This package provides fast hierarchical clustering algorithms compiled from C to
WebAssembly, with JavaScript/TypeScript wrappers for easy integration.

## Algorithm

**Agglomerative hierarchical clustering with average linkage (UPGMA).** Each
sample starts as its own cluster; at each step the two clusters with the
smallest mean pairwise Euclidean distance are merged, until one cluster remains.

This is equivalent to R's `hclust(method="average")`, with two differences: R
uses the Lance-Williams recurrence for an O(n²) merge step, whereas this
recomputes average distances from the original matrix each iteration (O(n³)).
For the tens-to-hundreds of samples typical in genomics tracks, this is
negligible and WASM more than compensates. R also accepts a precomputed distance
matrix; this library computes Euclidean distances from raw vectors internally.

## Features

- Fast distance matrix computation using WASM
- Float32 precision for memory efficiency
- Hierarchical clustering with average linkage (UPGMA)
- Multiple output formats including Newick, JSON, and tree visualization
- Cancellation support via a callback
- Utilities for parsing and serializing to Newick format

## Usage

```typescript
import { clusterData, printTree, toNewick, fromNewick } from '@gmod/hclust'

const data = [
  [1.0, 2.0, 3.0],
  [1.5, 2.5, 3.5],
  [10.0, 11.0, 12.0],
]

const result = await clusterData({ data })

// Print tree structure
printTree(result.tree, ['Sample A', 'Sample B', 'Sample C'])

// Get Newick format
const newick = toNewick(result.tree)
const tree = fromNewick(newick)
```

## Cancellation

`clusterData` accepts an optional `checkCancellation: () => void` callback,
called periodically during the WASM computation. Throw from it to cancel —
the error propagates out of `clusterData`.

```typescript
clusterData({
  data,
  checkCancellation: () => {
    if (shouldCancel) {
      throw new Error('cancelled')
    }
  },
})
```

This library is designed to run in a **web worker**. The WASM computation
deliberately never yields to the JS event loop — yielding would add overhead
that significantly slows large datasets, and running in a worker keeps the main
thread responsive. The consequence is that no other JS on the worker thread runs
while clustering is in progress, so a flag set from the same worker won't be
visible until after it completes. Two approaches work around this:

### SharedArrayBuffer (requires cross-origin isolation)

A `SharedArrayBuffer` can be written by one thread and read by another via
`Atomics` — a fast memory read with no I/O:

```typescript
// Create a shared flag (requires COOP/COEP headers on the page)
const flag = new Int32Array(new SharedArrayBuffer(4))

// From another thread (e.g. the main thread messaging this worker):
// Atomics.store(flag, 0, 1)  // signal cancellation

clusterData({
  data,
  checkCancellation: () => {
    if (Atomics.load(flag, 0) === 1) {
      throw new Error('cancelled')
    }
  },
})
```

Cross-origin isolation requires these HTTP response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Blob URL + synchronous XHR (web workers only)

Without cross-origin isolation, use a blob URL as a cancellation token.
Revoking the URL causes a synchronous XHR to it to throw, signalling
cancellation. Synchronous XHR is only permitted in web workers.

```typescript
const token = URL.createObjectURL(new Blob())

// To cancel: URL.revokeObjectURL(token)

clusterData({
  data,
  checkCancellation: () => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', token, false) // synchronous
    try {
      xhr.send(null)
    } catch {
      throw new Error('cancelled')
    }
  },
})
```

### Summary

| Approach | Works on main thread | Works in web worker | Requires cross-origin isolation |
|---|---|---|---|
| SharedArrayBuffer + Atomics | yes | yes | yes |
| Blob URL + sync XHR | no | yes | no |

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
