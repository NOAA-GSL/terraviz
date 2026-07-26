// SPDX-License-Identifier: Apache-2.0
/**
 * Regional-dataset placement on the THREE-based globe.
 *
 * `photorealEarth`'s overlay shader clips a regional dataset to its
 * `boundingBox`. The maths was copied from the 2D globe
 * (`earthTileLayer.ts`), but the two run on spheres with OPPOSITE
 * texture-coordinate conventions:
 *
 *   earthTileLayer  builds its own sphere: `v = y / hSegs` with
 *                   `lat = pi/2 - v*pi`, so v == 0 at the north pole.
 *   THREE           SphereGeometry puts uv.y == 1 at the north pole.
 *
 * Copying `lat = (0.5 - v) * 180` across inverted latitude, so a
 * regional dataset rendered into the mirrored hemisphere — the RRFS
 * smoke box (21..53N) appeared over the South Pacific in generated
 * thumbnails.
 *
 * These tests pin the convention rather than the pixels: the sphere's
 * actual UVs come from THREE, and the shader's own source is parsed
 * for the two expressions that depend on them. A GL render would be
 * stronger, but needs a browser; the fix was verified that way in a
 * WebGL2 context before landing (probing lat +37 / -37 / +52 / +22
 * against a two-row texture), and this guards the reasoning behind it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'

const srcFile = (name: string) => resolve(process.cwd(), 'src/services', name)
const SHADER_SRC = readFileSync(srcFile('photorealEarth.ts'), 'utf-8')

describe('THREE sphere UV convention', () => {
  it('puts uv.y == 1 at the north pole, unlike the 2D globe', () => {
    const geo = new THREE.SphereGeometry(1, 8, 6)
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    let northUvY: number | null = null
    let southUvY: number | null = null
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y > 0.999 && northUvY === null) northUvY = uv.getY(i)
      if (y < -0.999 && southUvY === null) southUvY = uv.getY(i)
    }

    expect(northUvY).toBe(1)
    expect(southUvY).toBe(0)
  })

  it('derives latitude with the sign that convention requires', () => {
    const geo = new THREE.SphereGeometry(1, 8, 6)
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    // The expression the shader uses, applied to real sphere UVs.
    const latFromUv = (v: number) => (v - 0.5) * 180

    for (let i = 0; i < pos.count; i++) {
      const expected = (Math.asin(Math.max(-1, Math.min(1, pos.getY(i)))) * 180) / Math.PI
      expect(latFromUv(uv.getY(i))).toBeCloseTo(expected, 4)
    }
  })
})

describe('photorealEarth bbox shader', () => {
  it('derives lat as (vMapUv.y - 0.5), not the 2D globe’s inverse', () => {
    expect(SHADER_SRC).toContain('float lat = (vMapUv.y - 0.5) * 180.0;')
    expect(SHADER_SRC).not.toContain('float lat = (0.5 - vMapUv.y) * 180.0;')
  })

  it('maps the box’s north edge to the image’s top row', () => {
    // THREE uploads with flipY, so v == 1 is the image's TOP row.
    // bv must therefore be 1 at lat == bn.
    expect(SHADER_SRC).toContain('float bv = (lat - bs) / max(bn - bs, 1e-6);')
    expect(SHADER_SRC).not.toContain('float bv = (bn - lat) / max(bn - bs, 1e-6);')

    const bv = (lat: number, bn: number, bs: number) => (lat - bs) / (bn - bs)
    expect(bv(53, 53, 21)).toBe(1) // north edge -> top row
    expect(bv(21, 53, 21)).toBe(0) // south edge -> bottom row
  })

  it('leaves the 2D globe’s own derivation alone', () => {
    // earthTileLayer builds a sphere with v == 0 at the north pole, so
    // its inverse form is correct there. Changing one must not be
    // taken as licence to "fix" the other.
    const twoD = readFileSync(srcFile('earthTileLayer.ts'), 'utf-8')
    expect(twoD).toContain('float lat = (0.5 - vUV.y) * 180.0;')
  })
})
