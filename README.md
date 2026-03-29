# @gmod/hclust

This package provides fast hierarchical clustering algorithms compiled from C to
WebAssembly, with JavaScript/TypeScript wrappers for easy integration.

## Features

- Fast distance matrix computation using WASM
- Float32 precision for memory efficiency
- Hierarchical clustering with average linkage
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

`clusterData` accepts an optional `checkCancellation` callback. It is called
periodically during the WASM clustering computation. To cancel, throw an error
from the callback — the error propagates out of `clusterData` and memory is
cleaned up via a `finally` block.

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

This library is designed to run in a **web worker**. The clustering computation
runs entirely in WASM without yielding to the JS event loop — yielding between
iterations (e.g. via `setTimeout` or `await`) would add overhead that
significantly slows large datasets. Running in a worker keeps the main thread
responsive while clustering proceeds at full speed.

The consequence is that no other JS on the worker thread can run while
clustering is in progress, so a simple flag set from within the same worker
won't be seen until after the computation finishes. The two approaches below
work around this by reading cancellation state through mechanisms that don't
require yielding:

### SharedArrayBuffer (works anywhere, requires cross-origin isolation)

A `SharedArrayBuffer` can be written from one thread and read from another using
`Atomics`, so the check is a fast memory read with no I/O:

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

Cross-origin isolation is required for `SharedArrayBuffer`. Set these HTTP
response headers on your page:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Synchronous XHR via a blob URL (web workers only)

If the page is not cross-origin isolated, you can use a blob URL as a
cancellation token. Revoking the URL causes a synchronous XHR to that URL to
fail, which signals cancellation. This relies on synchronous XHR, which is only
permitted in web workers (not on the main thread).

```typescript
// Create a blob URL token
const token = URL.createObjectURL(new Blob())

// To cancel from anywhere:
// URL.revokeObjectURL(token)

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

Synchronous XHR is blocked on the main thread to prevent freezing the UI, so
this approach only works inside a web worker.

### Summary

| Approach | Works on main thread | Works in web worker | Requires cross-origin isolation |
|---|---|---|---|
| SharedArrayBuffer + Atomics | yes | yes | yes |
| Blob URL + sync XHR | no | yes | no |

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
