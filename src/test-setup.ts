// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { vi } from 'vitest'

// happy-dom does not implement the Canvas 2D API. Stub it globally so any
// test that constructs a canvas (SphereRenderer glow textures, etc.) doesn't
// blow up on `canvas.getContext('2d')`.
if (typeof HTMLCanvasElement !== 'undefined') {
  const mockCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
    createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillStyle: '',
    // The path and text half. Added when the calibration pattern
    // (`src/output/calibrationPattern.ts`) became the first module to
    // stroke and label a canvas under test — it is not special, the
    // stub was simply never completed past what the first caller
    // needed. Anything asserting on *what* was drawn should inject its
    // own recorder rather than reach for these: they record nothing
    // useful, and their job is only to stop a real drawing path
    // throwing in a DOM that has no canvas.
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 0 }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
  }
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx)
}
