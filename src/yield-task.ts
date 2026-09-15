let yieldTask: (() => Promise<void>) | undefined

// See docs/cancellation.md for why each environment gets the task it does.
function pickYield() {
  const isNode =
    Object.prototype.toString.call(
      (globalThis as { process?: unknown }).process,
    ) === '[object process]'
  const isElectron =
    typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)
  if ((isElectron || !isNode) && typeof MessageChannel !== 'undefined') {
    const channel = new MessageChannel()
    let resolvers: (() => void)[] = []
    channel.port1.onmessage = () => {
      const pending = resolvers
      resolvers = []
      for (const resolve of pending) {
        resolve()
      }
    }
    return () =>
      new Promise<void>(resolve => {
        resolvers.push(resolve)
        channel.port2.postMessage(0)
      })
  }
  if (typeof setImmediate === 'function') {
    return () =>
      new Promise<void>(resolve => {
        setImmediate(resolve)
      })
  }
  return () =>
    new Promise<void>(resolve => {
      setTimeout(resolve, 0)
    })
}

export function yieldToEventLoop() {
  yieldTask ??= pickYield()
  return yieldTask()
}
