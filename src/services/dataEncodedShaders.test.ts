// SPDX-License-Identifier: Apache-2.0
/**
 * Shader-source guards for data-encoded video.
 *
 * `docs/DATA_ENCODED_VIDEO_PLAN.md` names two traps that a GL render
 * would catch but no unit test otherwise would, because both produce
 * a plausible-looking globe with wrong numbers underneath:
 *
 *   1. The VR shader applies contrast / saturation to the sampled
 *      diffuse *after* sampling. Luma is a measurement, not a look —
 *      a contrast of 1.2 reports a different value under the cursor
 *      than the pipeline measured, and the picture still looks fine.
 *   2. Both renderers tag the dataset texture `SRGBColorSpace`. Left
 *      that way, the hardware gamma-decodes every sample and shifts
 *      every value before the palette sees it (0.5 arrives as ~0.21).
 *
 * These parse the shader and the texture setup for the correct form
 * *and* the absence of the wrong one, and cross-guard the two
 * renderers so a fix applied to one is not quietly copied into the
 * other — the same technique, and the same reasoning, as
 * `photorealEarthBbox.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Source with `//` comments stripped, so a comment that quotes an
 *  expression cannot satisfy (or defeat) an assertion about code. */
const codeOf = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'src/services', name), 'utf-8')
    .replace(/\/\/[^\n]*/g, '')

const VR = codeOf('photorealEarth.ts')
const TWO_D = codeOf('earthTileLayer.ts')
const SECONDARY = codeOf('vrScene.ts')

describe('VR globe — the contrast/saturation bypass', () => {
  it('guards the colour-correction block behind the picture branch', () => {
    // The maths must sit inside the `else`, not run unconditionally.
    expect(VR).toMatch(/if\s*\(\s*uOverlayDataEncoded\s*==\s*1\s*\)/)
    const branch = VR.slice(VR.indexOf('uOverlayDataEncoded == 1'))
    const contrastAt = branch.indexOf('uContrast')
    const elseAt = branch.indexOf('} else {')
    expect(elseAt).toBeGreaterThan(-1)
    expect(contrastAt).toBeGreaterThan(elseAt)
  })

  it('samples the palette with the red channel as the lookup coordinate', () => {
    expect(VR).toMatch(
      /texture2D\(\s*uOverlayColorLut\s*,\s*vec2\(\s*sampledDiffuseColor\.r\s*,\s*0\.5\s*\)\s*\)/,
    )
  })

  it('composites against the base map rather than over black', () => {
    // Exact transparency is the point; mixing with the in-shader base
    // sample is what avoids a material or render-order change.
    expect(VR).toMatch(/mix\(\s*overlayBase\s*,\s*pal\.rgb\s*,\s*pal\.a\s*\)/)
  })
})

describe('dataset textures are read as code values, not colours', () => {
  it('VR opts the data texture out of the sRGB transfer function', () => {
    expect(VR).toMatch(/dataEncoded\s*\?\s*THREE_\.NoColorSpace\s*:\s*THREE_\.SRGBColorSpace/)
  })

  it('secondary globes opt out the same way', () => {
    expect(SECONDARY).toMatch(/scale\s*\?\s*THREE_\.NoColorSpace\s*:\s*THREE_\.SRGBColorSpace/)
  })

  it('neither Three.js surface tags a data texture sRGB unconditionally', () => {
    // The regression this pins is a future edit "simplifying" the
    // ternary back to a bare assignment. Scoped to the two functions
    // that configure a *dataset* texture — the base earth, cloud and
    // shadow textures are pictures and are still tagged sRGB
    // unconditionally, correctly.
    const configureFns = [
      ['photorealEarth', VR, 'function configureDatasetTexture'],
      ['vrScene', SECONDARY, 'function configureSecondaryTexture'],
    ] as const
    for (const [name, src, marker] of configureFns) {
      const start = src.indexOf(marker)
      expect(start, `${name} still has ${marker}`).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n  }', start))
      expect(body, `${name} does not assign sRGB unconditionally`)
        .not.toMatch(/colorSpace\s*=\s*THREE_\.SRGBColorSpace/)
      expect(body).toMatch(/NoColorSpace/)
    }
  })

  it('samples data textures nearest on every Three.js surface', () => {
    // Same argument as the encoder's flags=neighbor: a bilinear tap
    // across a nodata/data edge averages two codes into a value
    // nobody measured.
    expect(VR).toMatch(/dataEncoded\s*\?\s*THREE_\.NearestFilter\s*:\s*THREE_\.LinearFilter/)
    expect(SECONDARY).toMatch(/scale\s*\?\s*THREE_\.NearestFilter\s*:\s*THREE_\.LinearFilter/)
  })
})

describe('2D globe', () => {
  it('branches on uDataEncoded and looks the value up in the LUT', () => {
    expect(TWO_D).toMatch(/uniform\s+bool\s+uDataEncoded\s*;/)
    expect(TWO_D).toMatch(/uniform\s+sampler2D\s+uColorLut\s*;/)
    expect(TWO_D).toMatch(/texture\(\s*uColorLut\s*,\s*vec2\(\s*t\s*,\s*0\.5\s*\)\s*\)/)
  })

  it('keeps the picture path on the plain passthrough', () => {
    // The backwards-compatibility guarantee at the shader: a legacy
    // dataset still takes `texture(uDatasetTex, sampleUV)` verbatim.
    expect(TWO_D).toMatch(/fragColor\s*=\s*texture\(\s*uDatasetTex\s*,\s*sampleUV\s*\)\s*;/)
  })

  it('does not apply the 2D texture to the VR colour-correction path', () => {
    // Cross-guard: the 2D shader has no contrast/saturation of its
    // own on the dataset pass and must not grow one.
    const fragStart = TWO_D.indexOf('const datasetFragSrc')
    const frag = TWO_D.slice(fragStart, TWO_D.indexOf('`', TWO_D.indexOf('void main()', fragStart)))
    expect(frag).not.toMatch(/uContrast|uSaturation/)
  })

  it('enables blending only for the data-encoded pass', () => {
    expect(TWO_D).toMatch(/if\s*\(\s*dataEncoded\s*\)\s*\{[\s\S]{0,400}?gl2\.enable\(gl2\.BLEND\)/)
    expect(TWO_D).toMatch(/\}\s*else\s*\{\s*gl2\.disable\(gl2\.BLEND\)/)
  })

  it('samples the data texture nearest and without mipmaps', () => {
    expect(TWO_D).toMatch(/TEXTURE_MIN_FILTER,\s*gl\.NEAREST/)
    expect(TWO_D).toMatch(/TEXTURE_MAG_FILTER,\s*gl\.NEAREST/)
    const helper = TWO_D.slice(
      TWO_D.indexOf('function applyDataEncodedFiltering'),
      TWO_D.indexOf('function syncColorLut'),
    )
    expect(helper).not.toMatch(/generateMipmap/)
  })
})

describe('secondary VR globes', () => {
  it('gained a shader patch so they do not show raw grayscale', () => {
    // These had no onBeforeCompile at all before data-encoded video.
    expect(SECONDARY).toMatch(/uniform\s+int\s+uSecDataEncoded\s*;/)
    expect(SECONDARY).toMatch(/texture2D\(\s*uSecColorLut\s*,\s*vec2\(\s*sampledDiffuseColor\.r/)
  })
})
