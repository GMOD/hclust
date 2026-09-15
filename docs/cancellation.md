# Cancelling from a web worker

`clusterData` works in slices of about 50ms and yields one task between them, so
a worker can abort a run from a posted message:

```typescript
// worker
let controller: AbortController | undefined

self.onmessage = async ({ data: message }) => {
  if (message.type === 'cancel') {
    controller?.abort()
    return
  }
  controller = new AbortController()
  try {
    const { order } = await clusterData({
      data: message.rows,
      signal: controller.signal,
    })
    self.postMessage({ type: 'done', order })
  } catch (error) {
    self.postMessage({ type: 'failed', message: String(error) })
  }
}
```

The run rejects with `signal.reason`, a `DOMException` named `AbortError` unless
the caller passed its own, and frees its wasm allocations before it does. In
headless Chrome 153, an abort posted to a worker ended a 4.1s run 1–55ms after
the page sent it.

## How each environment yields

The abort only lands if the task the run yields to lets a posted message or a
timer run first.

- **Browsers, workers, Electron**: a `MessageChannel` task. Not
  `scheduler.yield()`: Chromium runs its continuation ahead of posted messages,
  and a worker loop yielding that way every 50ms ran 3.3s past an abort to
  completion, where the `MessageChannel` loop stopped within 23ms.
- **Node**: `setImmediate`. A MessagePort turn in Node runs no due timer, so a
  test that aborts from a `setTimeout` would never see it; `setImmediate` passes
  through the timers phase without `setTimeout`'s 1ms clamp.
- **jsdom under jest**: `setTimeout(0)`, since that environment removes
  `setImmediate`.

The run yields whether or not it has a signal. The task costs far less than the
slice it follows, and it keeps a worker answering other messages, including a
second clustering run, which interleaves with the first rather than queueing
behind it.
