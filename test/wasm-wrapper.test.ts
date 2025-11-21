import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hierarchicalClusterWasm } from '../src/wasm-wrapper.js'

const mockModule = {
  _malloc: vi.fn(),
  _free: vi.fn(),
  _hierarchicalCluster: vi.fn(),
  _setProgressCallback: vi.fn(),
  addFunction: vi.fn(),
  removeFunction: vi.fn(),
  HEAPF32: new Float32Array(1000),
  HEAP32: new Int32Array(1000),
}

vi.mock('../src/distance.js', () => ({
  default: vi.fn(() => Promise.resolve(mockModule)),
}))

describe('wasm-wrapper', () => {
  let memoryOffset = 0

  beforeEach(() => {
    vi.clearAllMocks()
    memoryOffset = 0

    mockModule._malloc.mockImplementation((size: number) => {
      const offset = memoryOffset
      memoryOffset += size / 4
      return offset * 4
    })

    mockModule._hierarchicalCluster.mockReturnValue(0)

    mockModule.addFunction.mockReturnValue(12345)
  })

  it('should allocate memory for data and results', async () => {
    const data = [
      [1, 2, 3],
      [4, 5, 6],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data })

    expect(mockModule._malloc).toHaveBeenCalledTimes(5)
    expect(mockModule._malloc).toHaveBeenCalledWith(6 * 4)
    expect(mockModule._malloc).toHaveBeenCalledWith(1 * 4)
    expect(mockModule._malloc).toHaveBeenCalledWith(2 * 4)
  })

  it('should free all allocated memory', async () => {
    const data = [[1, 2]]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data })

    expect(mockModule._free).toHaveBeenCalledTimes(5)
  })

  it('should copy input data to WASM memory', async () => {
    const data = [
      [1.5, 2.5],
      [3.5, 4.5],
    ]

    const heapSpy = vi.spyOn(mockModule.HEAPF32, 'set')
    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data })

    expect(heapSpy).toHaveBeenCalled()
    const flatData = heapSpy.mock.calls[0]?.[0] as Float32Array
    expect(Array.from(flatData)).toEqual([1.5, 2.5, 3.5, 4.5])
  })

  it('should call hierarchicalCluster with correct parameters', async () => {
    const data = [
      [1, 2, 3],
      [4, 5, 6],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data })

    expect(mockModule._hierarchicalCluster).toHaveBeenCalledWith(
      expect.any(Number),
      2,
      3,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    )
  })

  it('should throw error if clustering is cancelled', async () => {
    const data = [[1, 2]]

    mockModule._hierarchicalCluster.mockReturnValue(-1)
    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await expect(hierarchicalClusterWasm({ data })).rejects.toThrow(
      'aborted',
    )
  })

  it('should build tree from merge information', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)

    mockModule.HEAPF32[heightsOffset] = 1.5
    mockModule.HEAP32[mergeAOffset] = 0
    mockModule.HEAP32[mergeBOffset] = 1

    const result = await hierarchicalClusterWasm({ data })

    expect(result.tree).toBeDefined()
    expect(result.tree.height).toBe(1.5)
    expect(result.tree.children).toHaveLength(2)
  })

  it('should use sample labels if provided', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]
    const sampleLabels = ['Sample A', 'Sample B']

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)

    mockModule.HEAPF32[heightsOffset] = 1.0
    mockModule.HEAP32[mergeAOffset] = 0
    mockModule.HEAP32[mergeBOffset] = 1

    const result = await hierarchicalClusterWasm({ data, sampleLabels })

    expect(result.tree.children?.[0]?.name).toBe('Sample A')
    expect(result.tree.children?.[1]?.name).toBe('Sample B')
  })

  it('should use default labels when not provided', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)

    mockModule.HEAPF32[heightsOffset] = 1.0
    mockModule.HEAP32[mergeAOffset] = 0
    mockModule.HEAP32[mergeBOffset] = 1

    const result = await hierarchicalClusterWasm({ data })

    expect(result.tree.children?.[0]?.name).toBe('Sample 0')
    expect(result.tree.children?.[1]?.name).toBe('Sample 1')
  })

  it('should return order array', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)
    const orderOffset = mergeBOffset + (numSamples - 1)

    mockModule.HEAP32[orderOffset] = 0
    mockModule.HEAP32[orderOffset + 1] = 1

    const result = await hierarchicalClusterWasm({ data })

    expect(result.order).toEqual([0, 1])
  })

  it('should return heights array', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4

    mockModule.HEAPF32[heightsOffset] = 1.5

    const result = await hierarchicalClusterWasm({ data })

    expect(result.heights).toBeInstanceOf(Float32Array)
    expect(result.heights[0]).toBe(1.5)
  })

  it('should return merges array', async () => {
    const data = [
      [1, 2],
      [3, 4],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 2
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)

    mockModule.HEAP32[mergeAOffset] = 0
    mockModule.HEAP32[mergeBOffset] = 1

    const result = await hierarchicalClusterWasm({ data })

    expect(result.merges).toHaveLength(1)
    expect(result.merges[0]).toEqual([0, 1])
  })

  it('should setup progress callback when statusCallback is provided', async () => {
    const data = [[1, 2]]
    const statusCallback = vi.fn()

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data, statusCallback })

    expect(mockModule.addFunction).toHaveBeenCalled()
    expect(mockModule._setProgressCallback).toHaveBeenCalledWith(12345)
  })

  it('should setup progress callback when checkCancellation is provided', async () => {
    const data = [[1, 2]]
    const checkCancellation = vi.fn(() => false)

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data, checkCancellation })

    expect(mockModule.addFunction).toHaveBeenCalled()
    expect(mockModule._setProgressCallback).toHaveBeenCalledWith(12345)
  })

  it('should cleanup progress callback after completion', async () => {
    const data = [[1, 2]]
    const statusCallback = vi.fn()

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await hierarchicalClusterWasm({ data, statusCallback })

    expect(mockModule.removeFunction).toHaveBeenCalledWith(12345)
    expect(mockModule._setProgressCallback).toHaveBeenCalledWith(0)
  })

  it('should cleanup memory even if clustering throws error', async () => {
    const data = [[1, 2]]

    mockModule._hierarchicalCluster.mockReturnValue(-1)
    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await expect(hierarchicalClusterWasm({ data })).rejects.toThrow()

    expect(mockModule._free).toHaveBeenCalledTimes(5)
  })

  it('should cleanup callback even if clustering throws error', async () => {
    const data = [[1, 2]]
    const statusCallback = vi.fn()

    mockModule._hierarchicalCluster.mockReturnValue(-1)
    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    await expect(
      hierarchicalClusterWasm({ data, statusCallback }),
    ).rejects.toThrow()

    expect(mockModule.removeFunction).toHaveBeenCalledWith(12345)
    expect(mockModule._setProgressCallback).toHaveBeenCalledWith(0)
  })

  it('should handle 3 samples correctly', async () => {
    const data = [
      [1, 2],
      [1, 2],
      [5, 6],
    ]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    const numSamples = 3
    const vectorSize = 2
    const dataSize = numSamples * vectorSize
    const heightsOffset = (dataSize * 4) / 4
    const mergeAOffset = heightsOffset + (numSamples - 1)
    const mergeBOffset = mergeAOffset + (numSamples - 1)

    mockModule.HEAPF32[heightsOffset] = 0.5
    mockModule.HEAPF32[heightsOffset + 1] = 2.0
    mockModule.HEAP32[mergeAOffset] = 0
    mockModule.HEAP32[mergeAOffset + 1] = 1
    mockModule.HEAP32[mergeBOffset] = 1
    mockModule.HEAP32[mergeBOffset + 1] = 0

    const result = await hierarchicalClusterWasm({ data })

    expect(result.tree.children).toHaveLength(2)
    expect(result.heights).toHaveLength(2)
    expect(result.merges).toHaveLength(2)
    expect(result.order).toHaveLength(3)
  })

  it('should handle single sample', async () => {
    const data = [[1, 2, 3]]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)
    mockModule.HEAP32[0] = 0

    const result = await hierarchicalClusterWasm({ data })

    expect(result.tree.name).toBe('Sample 0')
    expect(result.tree.height).toBe(0)
    expect(result.tree.children).toBeUndefined()
    expect(result.heights).toHaveLength(0)
    expect(result.merges).toHaveLength(0)
    expect(result.order).toEqual([0])
  })

  it('should reuse module instance on subsequent calls', async () => {
    const data = [[1, 2]]

    mockModule.HEAPF32.fill(0)
    mockModule.HEAP32.fill(0)

    // @ts-expect-error
    const createModuleMock = (await import('../src/distance.js')).default
    const initialCallCount = vi.mocked(createModuleMock).mock.calls.length

    await hierarchicalClusterWasm({ data })
    await hierarchicalClusterWasm({ data })

    const finalCallCount = vi.mocked(createModuleMock).mock.calls.length
    expect(finalCallCount - initialCallCount).toBeLessThanOrEqual(1)
  })
})
