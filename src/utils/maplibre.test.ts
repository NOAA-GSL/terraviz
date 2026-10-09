// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'

const setWorkerUrl = vi.hoisted(() => vi.fn())
vi.mock('maplibre-gl', () => ({ setWorkerUrl }))

describe('utils/maplibre', () => {
  // The visual report masks every MapLibre canvas, so a blank map passes it;
  // this is what notices the worker going missing again.
  it('points MapLibre at the bundled worker on import', async () => {
    await import('./maplibre')

    expect(setWorkerUrl).toHaveBeenCalledTimes(1)
    // `worker_file` is how Vite marks a `?worker` import. A plain `?url`
    // would hand MapLibre the raw `.mjs`, whose import of
    // `./maplibre-gl-shared.mjs` falls through to the SPA fallback and
    // blanks every worker-backed layer again.
    expect(setWorkerUrl).toHaveBeenCalledWith(expect.stringContaining('worker_file'))
  })
})
