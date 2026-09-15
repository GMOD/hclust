import { describe, expect, it } from 'vitest'

import { clusterData } from '../src/cluster.ts'
import { hierarchicalClusterWasm } from '../src/wasm-wrapper.ts'

import type { ClusterProgress } from '../src/types.ts'

function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function rows(n: number, v: number, seed = 7) {
  const rnd = random(seed)
  return Array.from({ length: n }, () =>
    Float32Array.from({ length: v }, () => Math.floor(rnd() * 3)),
  )
}

function tiedMatrix(n: number) {
  const rnd = random(11)
  const m = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      m[i * n + j] = Math.floor(rnd() * 9)
    }
  }
  return m
}

async function abortDuring(
  phase: ClusterProgress['phase'],
  run: (options: {
    onProgress: (p: ClusterProgress) => void
    signal: AbortSignal
  }) => Promise<unknown>,
) {
  const controller = new AbortController()
  let abortedAt = 0
  const phases: string[] = []
  const error = await run({
    signal: controller.signal,
    onProgress: p => {
      phases.push(p.phase)
      if (!abortedAt && p.phase === phase && p.current > 0) {
        abortedAt = performance.now()
        setTimeout(() => {
          controller.abort()
        }, 0)
      }
    },
  }).then(
    () => undefined,
    (e: unknown) => e,
  )
  return { error, latency: performance.now() - abortedAt, phases }
}

describe('cancellation', () => {
  it('rejects an already-aborted signal without doing the work', async () => {
    const data = rows(3000, 2000)
    const start = performance.now()
    await expect(
      clusterData({ data, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('aborts mid-distance-phase from a timer', async () => {
    const data = rows(3000, 2000)
    const { error, latency, phases } = await abortDuring('distance', options =>
      clusterData({ data, ...options }),
    )
    expect(error).toMatchObject({ name: 'AbortError' })
    expect((error as Error).message).toMatch(/\baborted\b/)
    expect(phases.at(-1)).toBe('distance')
    expect(latency).toBeLessThan(250)
  })

  it('aborts mid-merge-phase from a timer', async () => {
    const distances = tiedMatrix(3000)
    const { error, latency, phases } = await abortDuring(
      'clustering',
      options => clusterData({ distances, ...options }),
    )
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(phases.at(-1)).toBe('clustering')
    expect(latency).toBeLessThan(250)
  })

  it('frees what a cancelled run held, so a full run fits after many', async () => {
    const n = 10000
    const rnd = random(3)
    const data = Array.from({ length: n }, () => [rnd() * 100, rnd() * 100])
    for (let i = 0; i < 6; i++) {
      const { error, phases } = await abortDuring('distance', options =>
        clusterData({ data, ...options }),
      )
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(phases).toContain('distance')
    }
    const result = await clusterData({ data })
    expect(result.order).toHaveLength(n)
  }, 60_000)
})

describe('slicing', () => {
  it('gives the same merges however the run is sliced', async () => {
    const data = rows(1200, 30)
    const whole = await hierarchicalClusterWasm({ data, sliceMs: Infinity })
    const sliced = await hierarchicalClusterWasm({ data, sliceMs: 0 })
    expect(sliced.heights).toEqual(whole.heights)
    expect(sliced.merges).toEqual(whole.merges)

    const matrix = tiedMatrix(700)
    const wholeMatrix = await hierarchicalClusterWasm({
      distances: matrix.slice(),
      sliceMs: Infinity,
    })
    const slicedMatrix = await hierarchicalClusterWasm({
      distances: matrix.slice(),
      sliceMs: 0,
    })
    expect(slicedMatrix.heights).toEqual(wholeMatrix.heights)
    expect(slicedMatrix.merges).toEqual(wholeMatrix.merges)
  })

  it('interleaves two runs on one module and returns both trees', async () => {
    const a = rows(2500, 300, 1)
    const b = rows(2000, 400, 2)
    const soloA = await clusterData({ data: a })
    const soloB = await clusterData({ data: b })

    const events: string[] = []
    const [resultA, resultB] = await Promise.all([
      clusterData({
        data: a,
        onProgress: p => events.push(`a:${p.phase}`),
      }).then(r => {
        events.push('a:done')
        return r
      }),
      clusterData({
        data: b,
        onProgress: p => events.push(`b:${p.phase}`),
      }).then(r => {
        events.push('b:done')
        return r
      }),
    ])

    expect(resultA.tree).toEqual(soloA.tree)
    expect(resultB.tree).toEqual(soloB.tree)
    const firstDone = Math.min(
      events.indexOf('a:done'),
      events.indexOf('b:done'),
    )
    const before = events.slice(0, firstDone)
    expect(before).toContain('a:distance')
    expect(before).toContain('b:distance')
  }, 60_000)
})
