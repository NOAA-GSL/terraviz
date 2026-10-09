// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, expectTypeOf, it } from 'vitest'
import { STAC_MEDIA_TYPES, STAC_VERSION, type StacSpatial, type StacTemporal } from './stac-types'

describe('STAC 1.1 projection types', () => {
  it('separates core resource version and media types from API conformance', () => {
    expect(STAC_VERSION).toBe('1.1.0')
    expect(STAC_MEDIA_TYPES).toEqual({ Catalog: 'application/json', Collection: 'application/json', Feature: 'application/geo+json' })
  })

  it('requires complete intervals and forbids fabricated unknown-geometry extents', () => {
    expectTypeOf<{ datetime: string }>().toExtend<StacTemporal>()
    expectTypeOf<{ datetime: null; start_datetime: string; end_datetime: string }>().toExtend<StacTemporal>()
    expectTypeOf<{ datetime: null }>().not.toExtend<StacTemporal>()
    expectTypeOf<{ geometry: null }>().toExtend<StacSpatial>()
    expectTypeOf<{ geometry: null; bbox: [number, number, number, number] }>().not.toExtend<StacSpatial>()
  })
})