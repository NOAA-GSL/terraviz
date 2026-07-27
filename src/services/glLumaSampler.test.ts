/**
 * Guards for the GL probe's upload configuration.
 *
 * These flags look like boilerplate and are not. The probe exists
 * because iOS Safari applies a colour transform when a video reaches a
 * 2D canvas; leaving `UNPACK_COLORSPACE_CONVERSION_WEBGL` at its
 * `BROWSER_DEFAULT_WEBGL` default invites the same class of transform
 * on the GL path, and the symptom would be identical — a globe that
 * looks correct and a number under the cursor that is quietly wrong.
 *
 * A real WebGL2 context is not available under happy-dom, so this
 * stubs one and asserts the calls. That is enough to catch the failure
 * this is written for: someone tidying away lines that look redundant.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGlLumaSampler } from './glLumaSampler'

interface Recorded {
  pixelStorei: [number, unknown][]
  texParameteri: [number, number][]
  uniforms: [number, number][]
  readPixelsCalls: number
  uploads: number
  throwOnNextUpload: boolean
}

const K = {
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
  UNPACK_FLIP_Y_WEBGL: 37440,
  NONE: 0,
  NEAREST: 9728,
  CLAMP_TO_EDGE: 33071,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
}

function stubGl(luma = 200) {
  const rec: Recorded = {
    pixelStorei: [], texParameteri: [], uniforms: [], readPixelsCalls: 0, uploads: 0,
    throwOnNextUpload: false,
  }
  const gl = {
    ...K,
    TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044, FLOAT: 5126, TRIANGLES: 4,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: () => {},
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => '', useProgram: () => {},
    createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {},
    getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    createTexture: () => ({}), bindTexture: () => {},
    pixelStorei: (k: number, v: unknown) => rec.pixelStorei.push([k, v]),
    texParameteri: (_t: number, k: number, v: number) => rec.texParameteri.push([k, v]),
    texImage2D: () => {
      if (rec.throwOnNextUpload) throw new DOMException('tainted', 'SecurityError')
      rec.uploads++
    },
    uniform2f: (_l: unknown, u: number, v: number) => rec.uniforms.push([u, v]),
    viewport: () => {}, drawArrays: () => {},
    readPixels: (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) => {
      rec.readPixelsCalls++
      out[0] = luma; out[1] = luma; out[2] = luma; out[3] = 255
    },
    deleteTexture: () => {}, deleteBuffer: () => {}, deleteProgram: () => {},
  }
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return document.createElement(tag)
    return { width: 0, height: 0, getContext: () => gl } as unknown as HTMLCanvasElement
  }) as typeof document.createElement)
  return rec
}

const video = (w = 4096, h = 2048) =>
  Object.assign(Object.create(HTMLVideoElement.prototype) as HTMLVideoElement, {
    videoWidth: w, videoHeight: h, currentTime: 0,
  })

describe('createGlLumaSampler', () => {
  it('disables the browser colour conversion on upload', () => {
    const rec = stubGl()
    createGlLumaSampler()
    const conv = rec.pixelStorei.find(([k]) => k === K.UNPACK_COLORSPACE_CONVERSION_WEBGL)
    expect(conv, 'UNPACK_COLORSPACE_CONVERSION_WEBGL must be set').toBeDefined()
    // NONE, not BROWSER_DEFAULT_WEBGL — the whole point of the module.
    expect(conv?.[1]).toBe(K.NONE)
    vi.restoreAllMocks()
  })

  it('uploads unpremultiplied and unflipped', () => {
    const rec = stubGl()
    createGlLumaSampler()
    // Premultiplying scales the value by its own alpha. Flipping Y
    // mirrors the data across the equator — the bug that has shipped
    // twice here.
    expect(rec.pixelStorei).toContainEqual([K.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false])
    expect(rec.pixelStorei).toContainEqual([K.UNPACK_FLIP_Y_WEBGL, false])
    vi.restoreAllMocks()
  })

  it('filters NEAREST so no neighbouring texel is blended in', () => {
    const rec = stubGl()
    createGlLumaSampler()
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_MIN_FILTER, K.NEAREST])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_MAG_FILTER, K.NEAREST])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_WRAP_S, K.CLAMP_TO_EDGE])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_WRAP_T, K.CLAMP_TO_EDGE])
    vi.restoreAllMocks()
  })

  it('samples the requested UV and returns the red channel', () => {
    const rec = stubGl(137)
    const s = createGlLumaSampler()!
    expect(s.sample(video(), { u: 0.25, v: 0.75 })).toBe(137)
    expect(rec.uniforms.at(-1)).toEqual([0.25, 0.75])
    expect(rec.readPixelsCalls).toBe(1)
    vi.restoreAllMocks()
  })

  it('re-uploads only when the frame changed', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const v = video()
    s.sample(v, { u: 0.1, v: 0.1 })
    s.sample(v, { u: 0.9, v: 0.9 })
    // A pointer stream over a paused video must not re-upload a 4096x2048
    // frame per event.
    expect(rec.uploads).toBe(1)
    v.currentTime = 1.5
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('re-uploads when the source is swapped, even at an identical frame key', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    // Two datasets of the same size, both at currentTime 0 — the normal
    // state right after a load. A key-only cache reports the previous
    // dataset's values against the new dataset's globe, silently.
    const a = video()
    const b = video()
    s.sample(a, { u: 0.5, v: 0.5 })
    s.sample(b, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('never assumes a canvas is current, since it can be redrawn in place', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const c = { width: 64, height: 32 } as unknown as HTMLCanvasElement
    s.sample(c, { u: 0.5, v: 0.5 })
    s.sample(c, { u: 0.5, v: 0.5 })
    // Same object, same size, but the pixels may have changed underneath.
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('forgets the cached source when an upload throws', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const v = video()
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(1)
    // Advance the frame so an upload is genuinely attempted, then make
    // it throw. A tainted upload must not leave the sampler believing
    // the texture holds this frame.
    v.currentTime = 1.5
    rec.throwOnNextUpload = true
    expect(s.sample(v, { u: 0.5, v: 0.5 })).toBeNull()
    // Same source, same currentTime — but the cache was invalidated, so
    // this must re-attempt rather than sample a texture holding the
    // previous frame.
    rec.throwOnNextUpload = false
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('returns null before a frame has decoded', () => {
    stubGl()
    const s = createGlLumaSampler()!
    expect(s.sample(video(0, 0), { u: 0.5, v: 0.5 })).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null after dispose rather than touching a freed context', () => {
    stubGl()
    const s = createGlLumaSampler()!
    s.dispose()
    expect(s.sample(video(), { u: 0.5, v: 0.5 })).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null when WebGL2 is unavailable, rather than falling back to 2D', () => {
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return document.createElement(tag)
      return { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)
    // A 2D fallback is the path this module replaces; reintroducing one
    // would put wrong numbers back on iOS.
    expect(createGlLumaSampler()).toBeNull()
    vi.restoreAllMocks()
  })
})
