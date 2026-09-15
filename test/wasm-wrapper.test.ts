import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hierarchicalClusterWasm } from '../src/wasm-wrapper.ts'

const buffer = new ArrayBuffer(4096)
const RUN = 4
const PROGRESS = 32
const INPUT = 64
const MERGES = 2048
const STEP_DONE = 0
const STEP_MORE = 1
const STEP_NON_FINITE = 2

const mockModule = {
  HEAPF32: new Float32Array(buffer),
  HEAP32: new Int32Array(buffer),
  _clusterBeginRows: vi.fn(),
  _clusterBeginMatrix: vi.fn(),
  _clusterInput: vi.fn(),
  _clusterStep: vi.fn(),
  _clusterProgress: vi.fn(),
  _clusterMerges: vi.fn(),
  _clusterFree: vi.fn(),
}

vi.mock('../src/wasm/distance.js', () => ({
  default: vi.fn(() => Promise.resolve(mockModule)),
}))

function setMerges(heights: number[], pairs: [number, number][]) {
  const m = heights.length
  heights.forEach((h, i) => {
    mockModule.HEAPF32[MERGES / 4 + i] = h
    mockModule.HEAP32[MERGES / 4 + m + i] = pairs[i]![0]
    mockModule.HEAP32[MERGES / 4 + 2 * m + i] = pairs[i]![1]
  })
}

function setProgress(phase: number, current: number, total: number) {
  mockModule.HEAP32.set([phase, current, total], PROGRESS / 4)
}

const twoRows = [
  [1, 2],
  [3, 4],
]

describe('wasm-wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    new Uint8Array(buffer).fill(0)
    mockModule._clusterBeginRows.mockReturnValue(RUN)
    mockModule._clusterBeginMatrix.mockReturnValue(RUN)
    mockModule._clusterInput.mockReturnValue(INPUT)
    mockModule._clusterStep.mockReturnValue(STEP_DONE)
    mockModule._clusterProgress.mockReturnValue(PROGRESS)
    mockModule._clusterMerges.mockReturnValue(MERGES)
  })

  it('begins a row run and copies the rows into its input', async () => {
    await hierarchicalClusterWasm({
      data: [
        [1.5, 2.5, 3],
        [3.5, 4.5, 5],
      ],
    })
    expect(mockModule._clusterBeginRows).toHaveBeenCalledWith(2, 3)
    expect(
      Array.from(mockModule.HEAPF32.subarray(INPUT / 4, INPUT / 4 + 6)),
    ).toEqual([1.5, 2.5, 3, 3.5, 4.5, 5])
    expect(mockModule._clusterFree).toHaveBeenCalledWith(RUN)
  })

  it('hands a distance matrix to a matrix run untouched', async () => {
    await hierarchicalClusterWasm({
      distances: new Float32Array([0, 3, 0, 0]),
    })
    expect(mockModule._clusterBeginRows).not.toHaveBeenCalled()
    expect(mockModule._clusterBeginMatrix).toHaveBeenCalledWith(2)
    expect(
      Array.from(mockModule.HEAPF32.subarray(INPUT / 4, INPUT / 4 + 4)),
    ).toEqual([0, 3, 0, 0])
  })

  it('steps until done and builds the tree from the merges', async () => {
    mockModule._clusterStep
      .mockReturnValueOnce(STEP_MORE)
      .mockReturnValueOnce(STEP_MORE)
      .mockReturnValueOnce(STEP_DONE)
    setMerges(
      [0.5, 2],
      [
        [0, 1],
        [0, 2],
      ],
    )
    const result = await hierarchicalClusterWasm({
      data: [[1], [1], [5]],
      sampleLabels: ['a', 'b', 'c'],
    })
    expect(mockModule._clusterStep).toHaveBeenCalledTimes(3)
    expect(Array.from(result.heights)).toEqual([0.5, 2])
    expect(result.merges).toEqual([
      [0, 1],
      [0, 2],
    ])
    expect(result.order).toEqual([2, 0, 1])
    expect(result.tree.height).toBe(2)
    expect(result.tree.children?.[1]?.children?.[0]?.name).toBe('a')
    expect(mockModule._clusterFree).toHaveBeenCalledTimes(1)
  })

  it('names leaves Sample i without labels', async () => {
    setMerges([1], [[0, 1]])
    const result = await hierarchicalClusterWasm({ data: twoRows })
    expect(result.tree.children?.map(c => c.name)).toEqual([
      'Sample 0',
      'Sample 1',
    ])
  })

  it('reports progress per phase at most every 100ms', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const steps: [number, number, number, number][] = [
      [100, 0, 3, 10],
      [150, 1, 5, 9],
      [250, 1, 7, 9],
    ]
    mockModule._clusterStep.mockImplementation(() => {
      const next = steps.shift()
      if (!next) {
        return STEP_DONE
      }
      const [time, phase, current, total] = next
      clock = time
      setProgress(phase, current, total)
      return STEP_MORE
    })
    const onProgress = vi.fn()
    await hierarchicalClusterWasm({ data: twoRows, onProgress })
    expect(onProgress.mock.calls).toEqual([
      [
        {
          phase: 'distance',
          message: 'Computing distance matrix',
          current: 3,
          total: 10,
        },
      ],
      [
        {
          phase: 'clustering',
          message: 'Clustering samples',
          current: 7,
          total: 9,
        },
      ],
    ])
  })

  it('rejects a ragged row by name before touching the module', async () => {
    await expect(
      hierarchicalClusterWasm({ data: [[1, 2], [3]] }),
    ).rejects.toThrow('row 1 has 1 columns, row 0 has 2')
    expect(mockModule._clusterBeginRows).not.toHaveBeenCalled()
  })

  it('refuses a matrix the 2GB heap cannot hold before allocating', async () => {
    const wide = { length: 300_000_000 }
    await expect(
      hierarchicalClusterWasm({ data: [wide, wide] }),
    ).rejects.toThrow(
      'out of memory clustering 2 samples x 300000000 columns: the input matrix needs 2.40GB and the distance matrix 0.00GB, both inside a 2.15GB wasm heap',
    )
    expect(mockModule._clusterBeginRows).not.toHaveBeenCalled()
  })

  it('reports a run the heap cannot supply as out of memory', async () => {
    mockModule._clusterBeginRows.mockReturnValue(0)
    await expect(hierarchicalClusterWasm({ data: twoRows })).rejects.toThrow(
      /the input matrix needs 0\.00GB and the distance matrix 0\.00GB, both inside a 2\.15GB wasm heap$/,
    )
    expect(mockModule._clusterFree).not.toHaveBeenCalled()
  })

  it('names the runs sharing the heap when one cannot begin beside them', async () => {
    const controller = new AbortController()
    mockModule._clusterStep.mockReturnValue(STEP_MORE)
    const first = hierarchicalClusterWasm({
      data: twoRows,
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(mockModule._clusterStep).toHaveBeenCalled()
    })
    mockModule._clusterBeginRows.mockReturnValue(0)
    await expect(hierarchicalClusterWasm({ data: twoRows })).rejects.toThrow(
      'wasm heap, shared with 1 other clustering run in progress',
    )
    controller.abort()
    await expect(first).rejects.toThrow('aborted')
  })

  it('throws on non-finite input and frees the run', async () => {
    mockModule._clusterStep
      .mockReturnValueOnce(STEP_MORE)
      .mockReturnValueOnce(STEP_NON_FINITE)
    await expect(hierarchicalClusterWasm({ data: twoRows })).rejects.toThrow(
      'input contains non-finite values (NaN or Infinity)',
    )
    expect(mockModule._clusterFree).toHaveBeenCalledWith(RUN)
  })

  it('rejects an already-aborted signal without beginning a run', async () => {
    await expect(
      hierarchicalClusterWasm({ data: twoRows, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockModule._clusterBeginRows).not.toHaveBeenCalled()
  })

  it('stops stepping and frees the run once the signal aborts', async () => {
    const controller = new AbortController()
    mockModule._clusterStep.mockImplementation(() => {
      if (mockModule._clusterStep.mock.calls.length === 3) {
        controller.abort()
      }
      return STEP_MORE
    })
    await expect(
      hierarchicalClusterWasm({ data: twoRows, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockModule._clusterStep).toHaveBeenCalledTimes(3)
    expect(mockModule._clusterFree).toHaveBeenCalledWith(RUN)
  })

  it('frees the run when onProgress throws', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 200))
    mockModule._clusterStep.mockReturnValue(STEP_MORE)
    await expect(
      hierarchicalClusterWasm({
        data: twoRows,
        onProgress: () => {
          throw new Error('listener failed')
        },
      }),
    ).rejects.toThrow('listener failed')
    expect(mockModule._clusterFree).toHaveBeenCalledWith(RUN)
  })

  it('throws for fewer than 2 samples', async () => {
    await expect(
      hierarchicalClusterWasm({ data: [[1, 2, 3]] }),
    ).rejects.toThrow('at least 2 samples')
  })

  it('reuses the module instance', async () => {
    const createModuleMock = (await import('../src/wasm/distance.js')).default
    const before = vi.mocked(createModuleMock).mock.calls.length
    await hierarchicalClusterWasm({ data: twoRows })
    await hierarchicalClusterWasm({ data: twoRows })
    expect(
      vi.mocked(createModuleMock).mock.calls.length - before,
    ).toBeLessThanOrEqual(1)
  })
})
