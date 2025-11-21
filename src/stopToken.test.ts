import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkStopToken } from './stopToken.js'

describe('stopToken', () => {
  describe('checkStopToken', () => {
    beforeEach(() => {
      vi.stubGlobal('XMLHttpRequest', undefined)
      vi.stubGlobal('WorkerGlobalScope', undefined)
    })

    it('should do nothing when stopToken is undefined', () => {
      expect(() => {
        checkStopToken(undefined)
      }).not.toThrow()
    })

    it('should do nothing in non-worker environment', () => {
      expect(() => {
        checkStopToken('test-token')
      }).not.toThrow()
    })

    it('should skip in jest environment', () => {
      vi.stubGlobal('jest', {})

      expect(() => {
        checkStopToken('test-token')
      }).not.toThrow()

      vi.unstubAllGlobals()
    })
  })
})
