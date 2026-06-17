import { describe, expect, it, vi } from 'vitest'
import {
  canvasToBlob,
  generateGlobeThumbnail,
  orthoHalfExtent,
  resolveGlobeThumbnailOptions,
} from './globeThumbnail'

describe('resolveGlobeThumbnailOptions', () => {
  it('fills in the documented defaults', () => {
    expect(resolveGlobeThumbnailOptions()).toEqual({
      size: 512,
      supersample: 2,
      fill: 0.92,
      mime: 'image/webp',
      quality: 0.92,
      lonOrigin: 0,
      latOrigin: 0,
    })
  })

  it('passes longitude through and clamps latitude tilt to ±90', () => {
    expect(resolveGlobeThumbnailOptions({ lonOrigin: 200 }).lonOrigin).toBe(200)
    expect(resolveGlobeThumbnailOptions({ latOrigin: 45 }).latOrigin).toBe(45)
    expect(resolveGlobeThumbnailOptions({ latOrigin: 200 }).latOrigin).toBe(90)
    expect(resolveGlobeThumbnailOptions({ latOrigin: -200 }).latOrigin).toBe(-90)
  })

  it('rounds and clamps the output size into the supported range', () => {
    expect(resolveGlobeThumbnailOptions({ size: 100.6 }).size).toBe(101)
    expect(resolveGlobeThumbnailOptions({ size: 4 }).size).toBe(16)
    expect(resolveGlobeThumbnailOptions({ size: 99999 }).size).toBe(2048)
  })

  it('bounds supersample, fill, and quality to their valid fractions', () => {
    expect(resolveGlobeThumbnailOptions({ supersample: 50 }).supersample).toBe(4)
    expect(resolveGlobeThumbnailOptions({ supersample: 0 }).supersample).toBe(1)
    expect(resolveGlobeThumbnailOptions({ fill: 5 }).fill).toBe(1)
    expect(resolveGlobeThumbnailOptions({ fill: 0 }).fill).toBe(0.1)
    expect(resolveGlobeThumbnailOptions({ quality: 2 }).quality).toBe(1)
  })

  it('only accepts png as an alternative mime, else falls back to webp', () => {
    expect(resolveGlobeThumbnailOptions({ mime: 'image/png' }).mime).toBe('image/png')
    expect(
      resolveGlobeThumbnailOptions({ mime: 'image/gif' as unknown as 'image/png' }).mime,
    ).toBe('image/webp')
  })
})

describe('orthoHalfExtent', () => {
  it('is 1/fill so a unit sphere leaves the requested margin', () => {
    expect(orthoHalfExtent(1)).toBe(1)
    expect(orthoHalfExtent(0.5)).toBe(2)
    expect(orthoHalfExtent(0.92)).toBeCloseTo(1.087, 3)
  })

  it('clamps degenerate fills', () => {
    expect(orthoHalfExtent(0)).toBe(10) // 1/0.1
    expect(orthoHalfExtent(5)).toBe(1) // 1/1
  })
})

describe('canvasToBlob', () => {
  it('resolves with the produced blob', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' })
    const canvas = {
      toBlob: (cb: BlobCallback) => cb(blob),
    } as unknown as HTMLCanvasElement
    await expect(canvasToBlob(canvas, 'image/webp', 0.9)).resolves.toBe(blob)
  })

  it('rejects when the encoder returns null', async () => {
    const canvas = {
      toBlob: (cb: BlobCallback) => cb(null),
    } as unknown as HTMLCanvasElement
    await expect(canvasToBlob(canvas, 'image/webp', 0.9)).rejects.toThrow(/returned null/)
  })
})

/**
 * Fake Three.js module. WebGL can't run under happy-dom, so the
 * orchestration is exercised against a stand-in that records the
 * calls + disposals we care about (render fired, every GPU resource
 * released).
 */
function fakeThree() {
  const events: string[] = []
  const blob = new Blob(['rendered'], { type: 'image/webp' })
  class WebGLRenderer {
    domElement: unknown
    constructor(opts: { canvas: unknown }) {
      this.domElement = opts.canvas
    }
    setSize() {}
    setClearColor() {}
    render() {
      events.push('render')
    }
    dispose() {
      events.push('renderer.dispose')
    }
    forceContextLoss() {
      events.push('renderer.forceContextLoss')
    }
  }
  class Scene {
    add() {}
  }
  class OrthographicCamera {
    position = { set: vi.fn() }
    constructor(
      public left: number,
      public right: number,
      public top: number,
      public bottom: number,
      public near: number,
      public far: number,
    ) {}
    lookAt() {}
  }

  const three = {
    WebGLRenderer,
    Scene,
    OrthographicCamera,
    SRGBColorSpace: 'srgb',
    LinearFilter: 'linear',
  } as unknown as typeof import('three')

  return { three, events, blob }
}

/**
 * Fake earth factory — records lifecycle (addTo / setTexture /
 * update / removeFrom / dispose) and the texture spec it's handed
 * (so a test can assert the dataset overlay was forwarded), and
 * fires `onReady` synchronously like the real image branch.
 */
function fakeEarthFactory(events: string[]) {
  const specs: Array<{ kind?: string; options?: unknown }> = []
  const createEarth = (() => ({
    globe: { rotation: { x: 0, y: 0 } },
    baseDiffuseTexture: null,
    baseEarthTexture: {},
    onBaseDiffuseChange: () => () => {},
    addTo: () => events.push('earth.addTo'),
    removeFrom: () => events.push('earth.removeFrom'),
    setTexture: (spec: { kind?: string; options?: unknown }, onReady?: () => void) => {
      specs.push(spec)
      events.push('earth.setTexture')
      onReady?.()
    },
    sunDir: {},
    update: () => events.push('earth.update'),
    dispose: () => events.push('earth.dispose'),
  })) as unknown as NonNullable<
    Parameters<typeof generateGlobeThumbnail>[2]
  >['createEarth']
  return { createEarth, specs }
}

function fakeCanvasFactory(blob: Blob) {
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage: vi.fn(),
  }
  return (width: number, height: number) =>
    ({
      width,
      height,
      getContext: () => ctx,
      toBlob: (cb: BlobCallback) => cb(blob),
    }) as unknown as HTMLCanvasElement
}

describe('generateGlobeThumbnail', () => {
  it('renders via the earth stack, captures a blob, and releases every resource', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth } = fakeEarthFactory(events)
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    const result = await generateGlobeThumbnail(
      source,
      { size: 256, supersample: 2 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )

    expect(result).toBe(blob)
    // The dataset texture is set + the render fires before teardown,
    // and every resource is released (a leaked context would exhaust
    // the browser pool after a few previews).
    expect(events).toEqual(
      expect.arrayContaining([
        'earth.addTo',
        'earth.setTexture',
        'earth.update',
        'render',
        'earth.removeFrom',
        'earth.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
    expect(events.indexOf('earth.setTexture')).toBeLessThan(events.indexOf('render'))
    expect(events.indexOf('render')).toBeLessThan(events.indexOf('earth.dispose'))
  })

  it('forwards the dataset overlay (bbox / flip / lonOrigin) to the earth texture', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth, specs } = fakeEarthFactory(events)
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement
    const overlay = { boundingBox: { n: 50, s: 10, w: -20, e: 20 }, isFlippedInY: true }

    await generateGlobeThumbnail(
      source,
      { overlay },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )

    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ kind: 'image', options: overlay })
  })

  it('still disposes resources when the render throws', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth } = fakeEarthFactory(events)
    // Force the render to throw.
    ;(three as unknown as { WebGLRenderer: { prototype: { render: () => void } } }).WebGLRenderer.prototype.render =
      () => {
        throw new Error('gl boom')
      }
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    await expect(
      generateGlobeThumbnail(
        source,
        {},
        { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
      ),
    ).rejects.toThrow('gl boom')

    expect(events).toEqual(
      expect.arrayContaining([
        'earth.removeFrom',
        'earth.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
  })
})
