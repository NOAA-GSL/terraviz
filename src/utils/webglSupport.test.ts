// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import { hasWebGL2 } from './webglSupport'

/**
 * A canvas stub that answers only the context types it is told to, so a
 * case can describe a browser precisely — "WebGL 1 but not 2" is the one
 * that matters and is otherwise unreachable on a real headless canvas.
 */
function canvasWith(...supported: string[]): () => HTMLCanvasElement {
  return () => ({
    getContext: (type: string) => (supported.includes(type) ? {} : null),
  }) as unknown as HTMLCanvasElement
}

describe('hasWebGL2', () => {
  it('accepts a browser with WebGL 2', () => {
    expect(hasWebGL2(canvasWith('webgl2'))).toBe(true)
  })

  it('rejects a browser with WebGL 1 but not WebGL 2', () => {
    // The regression guard for the MapLibre 6 upgrade. Before it, the
    // preflight was `getContext('webgl2') || getContext('webgl')`, so this
    // browser cleared it and then failed inside the renderer — losing the
    // troubleshooting screen and leaving a blank globe. If someone
    // reinstates the fallback, this is the case that fails.
    expect(hasWebGL2(canvasWith('webgl'))).toBe(false)
  })

  it('rejects a browser with no WebGL at all', () => {
    expect(hasWebGL2(canvasWith())).toBe(false)
  })

  it('rejects rather than throwing when context creation throws', () => {
    // Some drivers throw out of `getContext` instead of returning null.
    // That browser has no WebGL 2 either, and an exception here would
    // escape into boot ahead of the screen that explains the problem.
    const throwing = () => ({
      getContext: () => { throw new Error('GPU process crashed') },
    }) as unknown as HTMLCanvasElement
    expect(hasWebGL2(throwing)).toBe(false)
  })

  it('reads a real canvas through the default factory', () => {
    // Pins that the default argument is wired to the document at all — a
    // factory defaulted to something inert would make every call above
    // pass while the shipped path tested nothing.
    const spy = vi.spyOn(document, 'createElement')
    hasWebGL2()
    expect(spy).toHaveBeenCalledWith('canvas')
    spy.mockRestore()
  })
})
