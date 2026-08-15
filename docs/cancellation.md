# Cancelling from a web worker

`checkCancellation` runs synchronously, from inside the WASM call. That is what
makes it able to stop the run, and also what makes the obvious worker design not
work: while clustering is in progress the worker is blocked, so a `cancel`
message sent with `postMessage` sits in the event queue until the run it was
meant to interrupt has already finished.

The signal has to be readable without returning to the event loop. Two ways:

## SharedArrayBuffer + Atomics

The direct approach, and the one to use when you have it. The page writes a flag
into shared memory; the worker reads it synchronously mid-run.

```typescript
// main thread
const flag = new Int32Array(new SharedArrayBuffer(4))
worker.postMessage({ data, flag })
// later
Atomics.store(flag, 0, 1)

// worker
clusterData({
  data,
  checkCancellation: () => {
    if (Atomics.load(flag, 0)) throw new Error('cancelled')
  },
})
```

`SharedArrayBuffer` requires cross-origin isolation — the document must be
served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which also constrains what
third-party resources the page can embed.

## Blob URL + synchronous XHR

The fallback when the isolation headers are not available. Synchronous
`XMLHttpRequest` is permitted in workers (not on the main thread), so the worker
can poll an endpoint the page controls and block on the answer.

This costs a network round trip per check, so poll a cached local value and only
hit the endpoint every so often rather than on every `checkCancellation` call.
Prefer the `Atomics` version wherever the headers can be set.
