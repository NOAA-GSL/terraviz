// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OutputMonitor } from './manager'
import { DEFAULT_FRAMEBUFFER_WIDTH } from './protocol'
import {
  createOutputConfigStore,
  defaultOutputConfig,
  matchMonitorIndex,
  normalizeRotationOffset,
  renderConfigFrom,
  viewSettingsFrom,
  OUTPUT_CONFIG_STORAGE_KEY,
  OUTPUT_CONFIG_VERSION,
  parseOutputConfig,
  toPersistedOutput,
  type PersistedOutput,
  type StorageLike,
} from './outputPersistence'

function monitor(over: Partial<OutputMonitor> = {}): OutputMonitor {
  return {
    name: '\\\\.\\DISPLAY1',
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
    ...over,
  }
}

function persisted(over: Partial<PersistedOutput> = {}): PersistedOutput {
  return {
    label: 'output-1',
    monitorName: '\\\\.\\DISPLAY1',
    monitorOrigin: { x: 0, y: 0 },
    mode: 'sos-equirect',
    trackOperatorCamera: true,
    split: false,
    rotationOffsetDeg: 0,
    framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
    debugOverlay: false,
    ...over,
  }
}

function memoryStorage(initial?: string): StorageLike & { written: string[] } {
  let value = initial ?? null
  const written: string[] = []
  return {
    written,
    getItem: () => value,
    setItem: (_k, v) => {
      value = v
      written.push(v)
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('matchMonitorIndex', () => {
  it('matches on name and signed origin together', () => {
    expect(matchMonitorIndex(persisted(), [monitor()])).toBe(0)
  })

  it('refuses a name-only match', () => {
    // The rule this module exists for. Windows display names are
    // positional: the same `\\.\DISPLAY1` can name a different physical
    // panel after a replug. Restoring onto it would put a projector on
    // the wrong monitor with nothing on screen to say so.
    expect(
      matchMonitorIndex(persisted(), [monitor({ position: { x: 1920, y: 0 } })]),
    ).toBeNull()
  })

  it('refuses an origin-only match', () => {
    expect(matchMonitorIndex(persisted(), [monitor({ name: '\\\\.\\DISPLAY2' })])).toBeNull()
  })

  it('matches a negative origin, which is where the bug lived', () => {
    // The spike's primary-left monitor sat at x = −1680. An origin that
    // had been through an unsigned or logical conversion would miss it.
    const left = persisted({ monitorOrigin: { x: -1680, y: 0 } })
    expect(matchMonitorIndex(left, [monitor({ position: { x: -1680, y: 0 } })])).toBe(0)
  })

  it('matches an unnamed display by origin, rather than never matching', () => {
    // Linux reports `name: null` often enough that treating it as
    // unmatchable would make restore useless there.
    const unnamed = persisted({ monitorName: null })
    expect(matchMonitorIndex(unnamed, [monitor({ name: null })])).toBe(0)
  })

  it('picks the right monitor out of several', () => {
    const target = persisted({ monitorName: 'RIGHT', monitorOrigin: { x: 1920, y: 0 } })
    const monitors = [
      monitor({ name: 'LEFT', position: { x: -1680, y: 0 } }),
      monitor({ name: 'CENTRE' }),
      monitor({ name: 'RIGHT', position: { x: 1920, y: 0 } }),
    ]
    expect(matchMonitorIndex(target, monitors)).toBe(2)
  })

  it('returns null when the display is simply gone', () => {
    expect(matchMonitorIndex(persisted(), [])).toBeNull()
  })
})

describe('parseOutputConfig', () => {
  it('returns defaults for nothing stored', () => {
    expect(parseOutputConfig(null)).toEqual(defaultOutputConfig())
    // Off by default: an install that never enabled outputs must
    // enumerate no monitors and open no IPC link.
    expect(defaultOutputConfig().autoRestoreOnLaunch).toBe(false)
  })

  it('returns defaults for a blob that is not JSON', () => {
    expect(parseOutputConfig('{oh no')).toEqual(defaultOutputConfig())
  })

  it('resets on a version it does not recognise', () => {
    const future = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION + 1,
      outputs: [persisted()],
      autoRestoreOnLaunch: true,
    })

    // Half-applying a shape nobody wrote would spawn windows from
    // guesses. Losing a list the operator can rebuild in three clicks
    // is the cheaper failure.
    expect(parseOutputConfig(future)).toEqual(defaultOutputConfig())
  })

  it('round-trips a real config', () => {
    const config = {
      version: OUTPUT_CONFIG_VERSION,
      outputs: [persisted(), persisted({ label: 'output-2', split: true })],
      autoRestoreOnLaunch: true,
      concurrentDecoderBudget: 8,
    }
    expect(parseOutputConfig(JSON.stringify(config))).toEqual(config)
  })

  it('drops one malformed entry and keeps the rest', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [
        persisted(),
        { label: 'output-2' }, // no origin, no mode
        persisted({ label: 'output-3' }),
      ],
      autoRestoreOnLaunch: false,
    })

    const config = parseOutputConfig(raw)

    // One schema slip must not cost an installation its other outputs.
    expect(config.outputs.map(o => o.label)).toEqual(['output-1', 'output-3'])
  })

  it('rejects a NaN origin rather than storing one that never matches', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ ...persisted(), monitorOrigin: { x: 'nope', y: 0 } }],
      autoRestoreOnLaunch: false,
    })

    // A NaN compares unequal to itself, so such an entry would sit in
    // the config forever, silently matching nothing.
    expect(parseOutputConfig(raw).outputs).toEqual([])
  })

  it('rejects an unknown mode', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ ...persisted(), mode: 'fisheye' }],
      autoRestoreOnLaunch: false,
    })

    // Phase 2's mode, written by a newer build. This one cannot render
    // it, and spawning it as an equirect would be inventing intent.
    expect(parseOutputConfig(raw).outputs).toEqual([])
  })

  it.each([
    ['an absent budget', undefined, null],
    ['a null budget', null, null],
    ['a whole budget', 8, 8],
    ['a fractional budget', 4.7, 4],
    ['a zero budget', 0, null],
    ['a negative budget', -2, null],
    ['a string budget', '8', null],
  ])('reads %s as %s', (_label, stored, expected) => {
    // `null` means "nobody has measured this machine, ask it" — the
    // manager falls back to `maxVideoPanels()`. A stored 0 would refuse
    // every output *and* every control panel, which reads as a broken
    // app rather than as a setting, so it resolves to unset too.
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [],
      autoRestoreOnLaunch: false,
      concurrentDecoderBudget: stored,
    })
    expect(parseOutputConfig(raw).concurrentDecoderBudget).toBe(expected)
  })

  it('treats a non-boolean autoRestore as off', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [],
      autoRestoreOnLaunch: 'yes',
    })
    expect(parseOutputConfig(raw).autoRestoreOnLaunch).toBe(false)
  })

  it('defaults camera tracking on and split off, matching a fresh output', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ label: 'output-1', monitorName: null, monitorOrigin: { x: 0, y: 0 }, mode: 'sos-equirect' }],
      autoRestoreOnLaunch: false,
    })
    const [output] = parseOutputConfig(raw).outputs
    expect(output.trackOperatorCamera).toBe(true)
    expect(output.split).toBe(false)
  })

  it('restores a config written before rung 11 rather than dropping it', () => {
    // The whole reason rung 11 added its two fields *without* bumping
    // `OUTPUT_CONFIG_VERSION`. A bump would have reset every operator's
    // outputs on the launch after an update, to buy nothing — the older
    // shape is readable, it simply has no render settings.
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [
        {
          label: 'output-1',
          monitorName: '\\\\.\\DISPLAY1',
          monitorOrigin: { x: 0, y: 0 },
          mode: 'sos-equirect',
          trackOperatorCamera: true,
          split: false,
        },
      ],
      autoRestoreOnLaunch: true,
    })

    const { outputs } = parseOutputConfig(raw)

    expect(outputs).toHaveLength(1)
    expect(outputs[0].framebufferWidth).toBe(DEFAULT_FRAMEBUFFER_WIDTH)
    expect(outputs[0].debugOverlay).toBe(false)
  })

  it('keeps a stored resolution and defaults an unusable one', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [
        { ...persisted({ label: 'output-1' }), framebufferWidth: 8192, debugOverlay: true },
        // A hand-edited file, or a key some future build wrote as a
        // string.
        { ...persisted({ label: 'output-2' }), framebufferWidth: 'huge' },
        // A number, but not a rung this build offers — a ladder that
        // changed between versions, or someone typing into devtools.
        { ...persisted({ label: 'output-3' }), framebufferWidth: 3000 },
      ],
      autoRestoreOnLaunch: false,
    })

    const { outputs } = parseOutputConfig(raw)

    expect(outputs[0].framebufferWidth).toBe(8192)
    expect(outputs[0].debugOverlay).toBe(true)
    // Defaulted, not dropped: one bad key must not cost the operator
    // that output entirely.
    expect(outputs[1].framebufferWidth).toBe(DEFAULT_FRAMEBUFFER_WIDTH)
    // Narrowed to a rung here, so every later reader has one — the
    // scene would snap 3000 to 2048 while the panel's picker had no
    // option to show for it, and the operator no way to tell which
    // number was real.
    expect(outputs[2].framebufferWidth).toBe(DEFAULT_FRAMEBUFFER_WIDTH)
  })

  it('treats a non-boolean debug flag as off', () => {
    const raw = JSON.stringify({
      version: OUTPUT_CONFIG_VERSION,
      outputs: [{ ...persisted(), debugOverlay: 'yes' }],
      autoRestoreOnLaunch: false,
    })
    // A HUD is drawn into the captured signal. Anything but a real
    // `true` resolves to off.
    expect(parseOutputConfig(raw).outputs[0].debugOverlay).toBe(false)
  })
})

describe('toPersistedOutput', () => {
  it('copies the origin rather than aliasing the live monitor', () => {
    const live = monitor({ position: { x: -1680, y: 0 } })
    const output = toPersistedOutput({
      label: 'output-1',
      monitor: live,
      mode: 'sos-equirect',
      view: { trackCamera: false, split: true, rotationOffsetDeg: 0 },
      render: { framebufferWidth: 8192, debugOverlay: true, calibration: true },
    })

    live.position.x = 9999

    // An alias would let a later mutation rewrite history that was
    // already serialised once.
    expect(output.monitorOrigin.x).toBe(-1680)
    expect(output.trackOperatorCamera).toBe(false)
    expect(output.split).toBe(true)
    // Rung 11's render settings ride along, so an 8K output does not
    // silently come back at 4K next launch.
    expect(output.framebufferWidth).toBe(8192)
    expect(output.debugOverlay).toBe(true)
  })
})

describe('createOutputConfigStore', () => {
  it('reads back what it wrote', () => {
    const store = createOutputConfigStore(memoryStorage())
    const config = { ...defaultOutputConfig(), autoRestoreOnLaunch: true, outputs: [persisted()] }

    store.write(config)

    expect(store.read()).toEqual(config)
  })

  it('writes under the documented key', () => {
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')

    createOutputConfigStore(storage).write(defaultOutputConfig())

    expect(setItem.mock.calls[0][0]).toBe(OUTPUT_CONFIG_STORAGE_KEY)
  })

  it('is inert but usable when storage is unavailable', () => {
    const store = createOutputConfigStore(null)

    // Private-mode Safari and a locked-down webview should cost the
    // operator persistence, not the feature.
    expect(() => store.write({ ...defaultOutputConfig(), autoRestoreOnLaunch: true })).not.toThrow()
    expect(store.read()).toEqual(defaultOutputConfig())
  })

  it('survives a throwing setItem — a full quota must not break live outputs', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }

    expect(() => createOutputConfigStore(storage).write(defaultOutputConfig())).not.toThrow()
  })

  it('survives a throwing getItem', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
    }

    expect(createOutputConfigStore(storage).read()).toEqual(defaultOutputConfig())
  })
})

describe('normalizeRotationOffset (rung 14)', () => {
  it('defaults a config written before rung 14 to no rotation', () => {
    // The rung-11 rule: a missing key must not cost an operator their
    // outputs on the launch after an update.
    expect(normalizeRotationOffset(undefined)).toBe(0)
    expect(normalizeRotationOffset(null)).toBe(0)
    expect(normalizeRotationOffset('90')).toBe(0)
    expect(normalizeRotationOffset(Number.NaN)).toBe(0)
    expect(normalizeRotationOffset(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('keeps a value already in range exactly', () => {
    expect(normalizeRotationOffset(0)).toBe(0)
    expect(normalizeRotationOffset(137.5)).toBe(137.5)
    expect(normalizeRotationOffset(359.9)).toBe(359.9)
  })

  it('wraps rather than rejecting, unlike the framebuffer rung', () => {
    // The difference is whether the stored value means anything. A
    // width off the ladder is meaningless and gets replaced; 370° aims
    // the sphere exactly where 10° does, so discarding it would
    // silently un-calibrate an installation whose operator nudged past
    // a full turn.
    expect(normalizeRotationOffset(370)).toBeCloseTo(10, 10)
    expect(normalizeRotationOffset(360)).toBe(0)
    expect(normalizeRotationOffset(-20)).toBeCloseTo(340, 10)
    expect(normalizeRotationOffset(-400)).toBeCloseTo(320, 10)
  })

  it('round-trips through write and load', () => {
    const storage = memoryStorage()
    const store = createOutputConfigStore(storage)
    store.write({ ...defaultOutputConfig(), outputs: [persisted({ rotationOffsetDeg: 42.5 })] })

    expect(createOutputConfigStore(storage).read().outputs[0].rotationOffsetDeg).toBe(42.5)
  })

  it('survives an entry that predates the field', () => {
    // The whole entry must come back, not be dropped — one missing key
    // costing an installation its four projectors is the failure this
    // parse is written against.
    const raw = { ...persisted() } as Record<string, unknown>
    delete raw.rotationOffsetDeg
    const storage = memoryStorage()
    storage.setItem(
      OUTPUT_CONFIG_STORAGE_KEY,
      JSON.stringify({
        version: OUTPUT_CONFIG_VERSION,
        autoRestoreOnLaunch: false,
        outputs: [raw],
      }),
    )

    const loaded = createOutputConfigStore(storage).read()

    expect(loaded.outputs).toHaveLength(1)
    expect(loaded.outputs[0].rotationOffsetDeg).toBe(0)
  })
})

describe('viewSettingsFrom (rung 14)', () => {
  it('carries every view field a restore needs', () => {
    // Extracted because the mapping was written out twice — once in
    // `restoreOutputs`, once in `adoptOrphanedOutputs`. An operator who
    // calibrates a sphere and then reloads the control window would
    // otherwise get their rotation back from one path and not the
    // other, and the symptom is a picture turned a few degrees with
    // nothing on screen to explain it.
    expect(
      viewSettingsFrom(
        persisted({ trackOperatorCamera: false, split: true, rotationOffsetDeg: 42.5 }),
      ),
    ).toEqual({ trackCamera: false, split: true, rotationOffsetDeg: 42.5 })
  })
})

describe('renderConfigFrom (rung 14b)', () => {
  it('restores the window settings that were stored', () => {
    expect(renderConfigFrom(persisted({ framebufferWidth: 8192, debugOverlay: true }))).toEqual({
      framebufferWidth: 8192,
      debugOverlay: true,
      calibration: false,
    })
  })

  it('never brings the calibration pattern back, whatever was stored', () => {
    // What you calibrate persists; the act of calibrating does not.
    // The HUD beside it is an overlay *on* the content, so an
    // installation that restored with it on still shows its data. The
    // pattern *replaces* the content, so restoring it on would put a
    // graticule in front of an audience with no data behind it — the
    // difference between a setting that came back and an installation
    // that did not.
    //
    // Written against a raw blob with the field forced in, not against
    // `PersistedOutput`, because the type does not have it — which is
    // the mechanism, and this is the behaviour it buys.
    const stored = { ...persisted({}), calibration: true } as unknown as Parameters<
      typeof renderConfigFrom
    >[0]
    expect(renderConfigFrom(stored).calibration).toBe(false)
  })

  it('keeps the pattern out of what gets written, too', () => {
    const written = toPersistedOutput({
      label: 'output-1',
      monitor: monitor({}),
      mode: 'sos-equirect',
      view: { trackCamera: true, split: false, rotationOffsetDeg: 0 },
      render: { framebufferWidth: 4096, debugOverlay: false, calibration: true },
    })
    expect('calibration' in written).toBe(false)
  })
})
