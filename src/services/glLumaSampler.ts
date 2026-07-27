/**
 * Reading one texel of a data-encoded frame through WebGL.
 *
 * The probe used to sample with a 1×1 `drawImage` into a 2D canvas.
 * That path is wrong on iOS Safari: measured against a known 0..255
 * ramp it returns a smooth transform with the endpoints preserved and
 * up to 11 codes of error in between (gain ~1.003, offset ~+6), on
 * every variant — tagged, untagged, limited or full range alike.
 * `colorSpace: 'srgb'` on the context and the `getImageData` call does
 * not change it, and neither does reading from one full-size blit
 * instead of per-texel draws, so the transform is applied in the
 * video→canvas step itself rather than in anything the caller controls.
 * On a 0-50 mg m-2 scale that is ±2.2, and it is silent: the globe
 * still looks right, only the number under the cursor is wrong.
 *
 * The same measurement showed the WebGL path exact on iOS, Chrome and
 * Firefox. So the probe reads the way the globe renders — which is what
 * `docs/DATA_ENCODED_VIDEO_PLAN.md` wanted in the first place, so that
 * the value reported and the colour drawn cannot disagree.
 *
 * This deliberately builds its **own** context rather than borrowing
 * MapLibre's or Three's. That is exactly the configuration
 * `scripts/luma-range-check` validated — separate WebGL2 context,
 * `texImage2D` from the video element, render, `readPixels` — so what
 * ships is what was measured. Reusing a renderer's live texture would
 * be a different path, unmeasured, and would need per-renderer plumbing
 * for no gain the probe can observe.
 */

import type { ProbeSource, TexelUv } from './datasetProbe'
import { logger } from '../utils/logger'

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

// One texel, chosen by uniform. The whole 1×1 viewport is that texel,
// so there is nothing to interpolate and no dependence on quad
// orientation — which is where a V-flip would otherwise creep in.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, uUv).rgb, 1.0); }`

export interface GlLumaSampler {
  /** Luma 0-255 at `uv`, or null when there is nothing to read. */
  sample(source: ProbeSource, uv: TexelUv): number | null
  dispose(): void
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    logger.warn('[probe] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/**
 * Build a sampler, or `null` if WebGL2 is unavailable.
 *
 * A null return is not a degraded readout, it is no readout — callers
 * drop the value line entirely. There is no 2D-canvas fallback on
 * purpose: it is the path this module exists to replace, and silently
 * falling back to it would reintroduce wrong numbers on the one
 * platform that motivated the change.
 */
export function createGlLumaSampler(): GlLumaSampler | null {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // Read back in the same call as the draw; without this the
    // implicit swap can clear the buffer before readPixels runs.
    preserveDrawingBuffer: true,
  })
  if (!gl) {
    logger.warn('[probe] no webgl2 context; value readout unavailable')
    return null
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = vs && fs ? gl.createProgram() : null
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    logger.warn('[probe] program link failed:', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const uUv = gl.getUniformLocation(prog, 'uUv')
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // NONE, not the default BROWSER_DEFAULT_WEBGL: the browser's own
  // colour conversion on upload is the class of transform that breaks
  // the 2D path, and the value must arrive as the encoder wrote it.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  // flipY stays false so texture v == 0 is the image's top row, which
  // is the convention `latLonToTexelUv` returns.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  for (const [k, v] of [
    ['TEXTURE_MIN_FILTER', 'NEAREST'],
    ['TEXTURE_MAG_FILTER', 'NEAREST'],
    ['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'],
    ['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE'],
  ] as const) {
    gl.texParameteri(gl.TEXTURE_2D, gl[k] as number, gl[v] as number)
  }
  gl.viewport(0, 0, 1, 1)

  const px = new Uint8Array(4)
  let uploadedKey = ''
  let disposed = false

  return {
    sample(source: ProbeSource, uv: TexelUv): number | null {
      if (disposed) return null
      const width = source instanceof HTMLVideoElement
        ? source.videoWidth
        : source instanceof HTMLImageElement
          ? source.naturalWidth
          : source.width
      if (!width) return null

      // Re-upload only when the frame actually changed. A paused video
      // under a moving pointer would otherwise re-upload the same
      // frame on every event.
      const key = source instanceof HTMLVideoElement
        ? `v:${source.currentTime}:${source.videoWidth}`
        : `s:${width}`
      try {
        if (key !== uploadedKey) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
          uploadedKey = key
        }
        gl.uniform2f(uUv, uv.u, uv.v)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      } catch {
        // A cross-origin source without CORS taints the upload. That is
        // a configuration problem, not a per-pixel one, but it must not
        // take the pointer handler down with it.
        uploadedKey = ''
        return null
      }
      return px[0]
    },
    dispose() {
      disposed = true
      gl.deleteTexture(tex)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    },
  }
}
