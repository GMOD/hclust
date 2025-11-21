import { describe, expect, it, vi } from 'vitest'

import { clusterData } from './cluster.js'

vi.mock('./wasm-wrapper.js', () => ({
  hierarchicalClusterWasm: vi.fn(),
}))

import { hierarchicalClusterWasm } from './wasm-wrapper.js'

describe('clusterData', () => {
  it('should call hierarchicalClusterWasm with correct parameters', async () => {
    const mockWasmResult = {
      tree: {
        name: 'Root',
        height: 1.0,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      },
      order: [0, 1],
      heights: new Float32Array([1.0]),
      merges: [[0, 1]] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [3, 4],
    ]

    const result = await clusterData({ data })

    expect(hierarchicalClusterWasm).toHaveBeenCalledWith({
      data,
      sampleLabels: undefined,
      statusCallback: undefined,
      checkCancellation: undefined,
    })

    expect(result.tree).toEqual(mockWasmResult.tree)
    expect(result.order).toEqual([0, 1])
    expect(result.distances).toBeInstanceOf(Float32Array)
    expect(result.distances.length).toBe(4)
  })

  it('should pass sampleLabels to wasm wrapper', async () => {
    const mockWasmResult = {
      tree: {
        name: 'Root',
        height: 1.0,
        children: [
          { name: 'A', height: 0 },
          { name: 'B', height: 0 },
        ],
      },
      order: [0, 1],
      heights: new Float32Array([1.0]),
      merges: [[0, 1]] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [3, 4],
    ]
    const sampleLabels = ['A', 'B']

    await clusterData({ data, sampleLabels })

    expect(hierarchicalClusterWasm).toHaveBeenCalledWith({
      data,
      sampleLabels,
      statusCallback: undefined,
      checkCancellation: undefined,
    })
  })

  it('should pass onProgress callback to wasm wrapper', async () => {
    const mockWasmResult = {
      tree: { name: 'Root', height: 0 },
      order: [0],
      heights: new Float32Array([]),
      merges: [] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const onProgress = vi.fn()
    const data = [[1, 2]]

    await clusterData({ data, onProgress })

    expect(onProgress).toHaveBeenCalledWith(
      'Running hierarchical clustering in WASM...',
    )
    expect(hierarchicalClusterWasm).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCallback: onProgress,
      }),
    )
  })

  it('should create checkCancellation callback when stopToken is provided', async () => {
    const mockWasmResult = {
      tree: { name: 'Root', height: 0 },
      order: [0],
      heights: new Float32Array([]),
      merges: [] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const stopToken = 'test-token'
    const data = [[1, 2]]

    await clusterData({ data, stopToken })

    const calls = vi.mocked(hierarchicalClusterWasm).mock.calls
    const call = calls[calls.length - 1]?.[0]
    expect(call?.checkCancellation).toBeDefined()
    expect(typeof call?.checkCancellation).toBe('function')
  })

  it('should build clustersGivenK correctly for 2 samples', async () => {
    const mockWasmResult = {
      tree: {
        name: 'Root',
        height: 1.0,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      },
      order: [0, 1],
      heights: new Float32Array([1.0]),
      merges: [[0, 1]] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [3, 4],
    ]

    const result = await clusterData({ data })

    expect(result.clustersGivenK).toHaveLength(3)
    expect(result.clustersGivenK[0]).toEqual([[0, 1]])
    expect(result.clustersGivenK[1]).toEqual([[0], [1]])
    expect(result.clustersGivenK[2]).toEqual([])
  })

  it('should build clustersGivenK correctly for 3 samples', async () => {
    const mockWasmResult = {
      tree: {
        name: 'Root',
        height: 2.0,
        children: [
          {
            name: 'Cluster 0',
            height: 1.0,
            children: [
              { name: 'Sample 0', height: 0 },
              { name: 'Sample 1', height: 0 },
            ],
          },
          { name: 'Sample 2', height: 0 },
        ],
      },
      order: [0, 1, 2],
      heights: new Float32Array([1.0, 2.0]),
      merges: [
        [0, 1],
        [0, 1],
      ] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [1, 2],
      [5, 6],
    ]

    const result = await clusterData({ data })

    expect(result.clustersGivenK).toHaveLength(4)
    expect(result.clustersGivenK[0]?.length).toBe(1)
    expect(result.clustersGivenK[0]?.[0]).toContain(0)
    expect(result.clustersGivenK[0]?.[0]).toContain(1)
    expect(result.clustersGivenK[0]?.[0]).toContain(2)
    expect(result.clustersGivenK[1]).toHaveLength(2)
    expect(result.clustersGivenK[2]).toHaveLength(3)
    expect(result.clustersGivenK[3]).toEqual([])
  })

  it('should handle single sample case', async () => {
    const mockWasmResult = {
      tree: { name: 'Sample 0', height: 0 },
      order: [0],
      heights: new Float32Array([]),
      merges: [] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [[1, 2, 3]]

    const result = await clusterData({ data })

    expect(result.tree).toEqual({ name: 'Sample 0', height: 0 })
    expect(result.order).toEqual([0])
    expect(result.clustersGivenK).toHaveLength(2)
    expect(result.clustersGivenK[0]).toEqual([[0]])
    expect(result.clustersGivenK[1]).toEqual([])
  })

  it('should return distances as Float32Array', async () => {
    const mockWasmResult = {
      tree: { name: 'Root', height: 1.0 },
      order: [0, 1],
      heights: new Float32Array([1.0]),
      merges: [[0, 1]] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [3, 4],
    ]

    const result = await clusterData({ data })

    expect(result.distances).toBeInstanceOf(Float32Array)
    expect(result.distances.length).toBe(data.length * data.length)
  })

  it('should handle complex merge sequences', async () => {
    const mockWasmResult = {
      tree: {
        name: 'Root',
        height: 3.0,
      },
      order: [0, 1, 2, 3],
      heights: new Float32Array([1.0, 2.0, 3.0]),
      merges: [
        [0, 1],
        [0, 1],
        [0, 1],
      ] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [
      [1, 2],
      [1, 3],
      [5, 6],
      [5, 7],
    ]

    const result = await clusterData({ data })

    expect(result.clustersGivenK.length).toBe(5)
    expect(result.clustersGivenK[0]?.length).toBe(1)
    expect(result.clustersGivenK[result.clustersGivenK.length - 1]).toEqual([])
  })

  it('checkCancellation should return false when no error is thrown', async () => {
    const mockWasmResult = {
      tree: { name: 'Root', height: 0 },
      order: [0],
      heights: new Float32Array([]),
      merges: [] as [number, number][],
    }

    vi.mocked(hierarchicalClusterWasm).mockResolvedValue(mockWasmResult)

    const data = [[1, 2]]
    await clusterData({ data, stopToken: 'token' })

    const calls = vi.mocked(hierarchicalClusterWasm).mock.calls
    const call = calls[calls.length - 1]?.[0]
    const checkCancellation = call?.checkCancellation

    expect(checkCancellation?.()).toBe(false)
  })
})
