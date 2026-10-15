// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasForeignAncestor,
  initTourAuthoring,
  readTourEditParam,
  teardownTourAuthoring,
} from './index'

afterEach(() => {
  teardownTourAuthoring()
  // Reset location so the next test starts with no `?tourEdit=`.
  window.history.replaceState({}, '', '/')
})

describe('readTourEditParam', () => {
  it('returns null when the URL has no tourEdit param', () => {
    expect(readTourEditParam(new URL('https://t.local/'))).toBeNull()
  })

  it('returns null when the param is present but empty', () => {
    expect(readTourEditParam(new URL('https://t.local/?tourEdit='))).toBeNull()
  })

  it('returns the value when present', () => {
    expect(readTourEditParam(new URL('https://t.local/?tourEdit=new'))).toBe('new')
    expect(
      readTourEditParam(new URL('https://t.local/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA')),
    ).toBe('01HXAAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('initTourAuthoring (tour/A)', () => {
  it('returns null and mounts no dock when the URL has no tourEdit param', () => {
    window.history.replaceState({}, '', '/')
    const handle = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(handle).toBeNull()
    expect(document.querySelector('.tour-authoring-dock')).toBeNull()
  })

  it('mounts the dock when ?tourEdit= is present', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const handle = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(handle).not.toBeNull()
    expect(document.querySelector('.tour-authoring-dock')).toBeTruthy()
  })

  it('returns the same handle on a second call (idempotent guard)', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const first = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    const second = initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(second).toBe(first)
    // Only one dock in the DOM — guard prevents stacking.
    expect(document.querySelectorAll('.tour-authoring-dock')).toHaveLength(1)
  })

  it('clears the singleton when the host fires onDiscard', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    const onDiscard = vi.fn()
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard,
    })
    document.querySelector<HTMLButtonElement>('.tour-authoring-dock-close')!.click()
    expect(onDiscard).toHaveBeenCalledOnce()
    // Dock removed; a subsequent init (e.g. after navigation back
    // to tour-edit mode) should mount a fresh dock rather than
    // hitting the already-mounted guard.
    expect(document.querySelector('.tour-authoring-dock')).toBeNull()
  })

  it('adds body.tour-authoring-open while the dock is mounted', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    // CSS uses this body class to hide #help-trigger so it stops
    // overlapping the dock at top-right (z-index:600 vs the
    // dock's z-index:50).
    expect(document.body.classList.contains('tour-authoring-open')).toBe(true)
  })

  it('clears body.tour-authoring-open on discard', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    document.querySelector<HTMLButtonElement>('.tour-authoring-dock-close')!.click()
    expect(document.body.classList.contains('tour-authoring-open')).toBe(false)
  })

  it('clears body.tour-authoring-open on teardown', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    teardownTourAuthoring()
    expect(document.body.classList.contains('tour-authoring-open')).toBe(false)
  })

  it('collapses the browse overlay when mounting so the dock is visible', () => {
    window.history.replaceState({}, '', '/?tourEdit=new')
    // Seed a browse overlay in the open state, mimicking the
    // post-boot SPA where browse opened automatically because no
    // dataset is loaded.
    const overlay = document.createElement('div')
    overlay.id = 'browse-overlay'
    document.body.appendChild(overlay)
    document.body.classList.add('browse-open')
    initTourAuthoring({
      getMapView: () => null,
      getCurrentDataset: () => null,
      onDiscard: () => {},
    })
    expect(overlay.classList.contains('collapsed')).toBe(true)
    expect(document.body.classList.contains('browse-open')).toBe(false)
    overlay.remove()
  })
})

/** A window-shaped stand-in: which origin it is on, which origins
 *  sit above it, and whether reading the top's origin throws. */
function fakeWindow(opts: {
  origin: string
  framed: boolean
  ancestorOrigins?: string[]
  topOrigin?: string
}): Window {
  const win: { location: unknown; top: unknown } = {
    location: {
      origin: opts.origin,
      ancestorOrigins: opts.ancestorOrigins,
    },
    top: null,
  }
  if (!opts.framed) {
    win.top = win
  } else {
    win.top = {
      get location(): { origin: string } {
        if (opts.topOrigin === undefined) throw new DOMException('Blocked', 'SecurityError')
        return { origin: opts.topOrigin }
      },
    }
  }
  return win as unknown as Window
}

describe('hasForeignAncestor', () => {
  const NODE = 'https://node.example'

  it('is false for a top-level page', () => {
    expect(hasForeignAncestor(fakeWindow({ origin: NODE, framed: false }))).toBe(false)
  })

  it('is false when every ancestor is this origin', () => {
    expect(
      hasForeignAncestor(
        fakeWindow({ origin: NODE, framed: true, ancestorOrigins: [NODE, NODE], topOrigin: NODE }),
      ),
    ).toBe(false)
  })

  it('is true when any listed ancestor is another origin, top included or not', () => {
    // A foreign page in the middle, under a same-origin top.
    expect(
      hasForeignAncestor(
        fakeWindow({
          origin: NODE,
          framed: true,
          ancestorOrigins: ['https://evil.example', NODE],
          topOrigin: NODE,
        }),
      ),
    ).toBe(true)
  })

  it('treats a sandboxed ancestor ("null") as foreign', () => {
    expect(
      hasForeignAncestor(fakeWindow({ origin: NODE, framed: true, ancestorOrigins: ['null'] })),
    ).toBe(true)
  })

  it('falls back to the top window when ancestorOrigins is missing (Firefox)', () => {
    // Cross-origin: reading top.location throws.
    expect(hasForeignAncestor(fakeWindow({ origin: NODE, framed: true }))).toBe(true)
    expect(hasForeignAncestor(fakeWindow({ origin: NODE, framed: true, topOrigin: NODE }))).toBe(false)
  })
})

describe('initTourAuthoring inside another site', () => {
  it('mounts no dock when a foreign page frames the app', () => {
    window.history.replaceState({}, '', '/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA')
    const realTop = Object.getOwnPropertyDescriptor(window, 'top')
    Object.defineProperty(window, 'top', {
      configurable: true,
      get() {
        return {
          get location(): never {
            throw new DOMException('Blocked', 'SecurityError')
          },
        }
      },
    })
    try {
      const handle = initTourAuthoring({
        getMapView: () => null,
        getCurrentDataset: () => null,
        onDiscard: () => {},
      })
      expect(handle).toBeNull()
      expect(document.querySelector('.tour-authoring-dock')).toBeNull()
      expect(document.body.classList.contains('tour-authoring-open')).toBe(false)
    } finally {
      if (realTop) Object.defineProperty(window, 'top', realTop)
      else delete (window as { top?: unknown }).top
    }
    expect(window.top).toBe(window)
  })
})
