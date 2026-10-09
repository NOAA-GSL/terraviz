// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  crc32,
  readStoredEntry,
  readZipDirectory,
  type StoredZipRefusal,
  type ZipDirectoryEntry,
} from './storedZip'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** sphere-sim's own bundle, from its own `bundleEntries` and `buildZip`. */
const BUNDLE = new Uint8Array(
  readFileSync(resolve(__dirname, '../../output/fixtures/projectorWarp/sphere-sim-bundle.zip')),
)

interface TestEntry {
  name: string
  body: string | Uint8Array
  method?: number
  flags?: number
  /** Written into both headers in place of the real CRC. */
  crc?: number
  localName?: string
  localMethod?: number
  localExtra?: Uint8Array
  /** Streamed: zero sizes and CRC locally, a data descriptor after the data. */
  descriptor?: boolean
  size?: number
  compressedSize?: number
}

interface ArchiveOptions {
  comment?: Uint8Array
  /** Bytes before the archive that its offsets do not count — a self-extractor's stub. */
  prefix?: Uint8Array
  trailing?: Uint8Array
  zip64Locator?: boolean
  disk?: number
  entryCount?: number
}

function push16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff)
}
function push32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
}

/**
 * A writer shaped like sphere-sim's (`packages/web/src/zip.ts`): stored,
 * UTF-8 names, the DOS epoch — with a knob for each way an archive can
 * differ from that.
 */
function writeZip(entries: readonly TestEntry[], options: ArchiveOptions = {}): Uint8Array {
  const local: number[] = []
  const central: number[] = []
  for (const e of entries) {
    const name = enc.encode(e.name)
    const localName = enc.encode(e.localName ?? e.name)
    const body = typeof e.body === 'string' ? enc.encode(e.body) : e.body
    const crc = e.crc ?? crc32(body)
    const method = e.method ?? 0
    const flags = (e.flags ?? 0) | 0x800 | (e.descriptor ? 0x8 : 0)
    const extra = e.localExtra ?? new Uint8Array(0)
    const offset = local.length

    push32(local, 0x04034b50)
    push16(local, 20)
    push16(local, flags)
    push16(local, e.localMethod ?? method)
    push16(local, 0)
    push16(local, 0x21)
    push32(local, e.descriptor ? 0 : crc)
    push32(local, e.descriptor ? 0 : body.length)
    push32(local, e.descriptor ? 0 : body.length)
    push16(local, localName.length)
    push16(local, extra.length)
    local.push(...localName, ...extra, ...body)
    if (e.descriptor) {
      push32(local, 0x08074b50)
      push32(local, crc)
      push32(local, body.length)
      push32(local, body.length)
    }

    push32(central, 0x02014b50)
    push16(central, 20)
    push16(central, 20)
    push16(central, flags)
    push16(central, method)
    push16(central, 0)
    push16(central, 0x21)
    push32(central, crc)
    push32(central, e.compressedSize ?? body.length)
    push32(central, e.size ?? body.length)
    push16(central, name.length)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push32(central, 0)
    push32(central, offset)
    central.push(...name)
  }

  const end: number[] = []
  if (options.zip64Locator) {
    push32(end, 0x07064b50)
    push32(end, 0)
    push32(end, local.length + central.length)
    push32(end, 0)
    push32(end, 1)
  }
  const comment = options.comment ?? new Uint8Array(0)
  const count = options.entryCount ?? entries.length
  push32(end, 0x06054b50)
  push16(end, options.disk ?? 0)
  push16(end, 0)
  push16(end, count)
  push16(end, count)
  push32(end, central.length)
  push32(end, local.length)
  push16(end, comment.length)
  end.push(...comment)
  return Uint8Array.from([...(options.prefix ?? []), ...local, ...central, ...end, ...(options.trailing ?? [])])
}

function directory(archive: Uint8Array): readonly ZipDirectoryEntry[] {
  const read = readZipDirectory(archive)
  if (!read.ok) throw new Error(`expected a directory, got ${JSON.stringify(read.refusal)}`)
  return read.entries
}

function directoryRefusal(archive: Uint8Array): StoredZipRefusal {
  const read = readZipDirectory(archive)
  if (read.ok) throw new Error('expected a refusal')
  return read.refusal
}

function entryText(archive: Uint8Array, name: string): string {
  const entry = directory(archive).find((e) => e.name === name)
  if (entry === undefined) throw new Error(`no entry ${name}`)
  const read = readStoredEntry(archive, entry)
  if (!read.ok) throw new Error(`expected bytes, got ${JSON.stringify(read.refusal)}`)
  return dec.decode(read.bytes)
}

function entryRefusal(archive: Uint8Array, name: string): StoredZipRefusal {
  const entry = directory(archive).find((e) => e.name === name)
  if (entry === undefined) throw new Error(`no entry ${name}`)
  const read = readStoredEntry(archive, entry)
  if (read.ok) throw new Error('expected a refusal')
  return read.refusal
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('sphere-sim\'s own bundle', () => {
  it('lists every entry in the order the writer put them, README first', () => {
    expect(directory(BUNDLE).map((e) => e.name)).toEqual([
      'README.txt',
      // Second, since sphere-sim#52: where each mesh goes.
      'layout.json',
      'warp/P1.data',
      'warp/P2.data',
      'warp/P3.data',
      'warp/P4.data',
      'alignment/P1.alignment',
      'alignment/P2.alignment',
      'alignment/P3.alignment',
      'alignment/P4.alignment',
      'restore/MANIFEST.txt',
      'restore/warp/P1.data',
    ])
    expect(directory(BUNDLE).every((e) => e.method === 0 && !e.encrypted)).toBe(true)
  })

  it('reads every entry against its own checksum', () => {
    for (const entry of directory(BUNDLE)) {
      const read = readStoredEntry(BUNDLE, entry)
      expect(read.ok, entry.name).toBe(true)
    }
    // The mesh and the older copy of it a restore point keeps: same name, different grid.
    expect(entryText(BUNDLE, 'warp/P1.data').startsWith('2\n5 5\n')).toBe(true)
    expect(entryText(BUNDLE, 'restore/warp/P1.data').startsWith('2\n4 4\n')).toBe(true)
  })
})

describe('readZipDirectory', () => {
  it('round-trips names and bytes, and hands back views rather than copies', () => {
    const archive = writeZip([
      { name: 'warp/P1.data', body: 'one' },
      { name: 'warp/Projektor-ü.data', body: 'two' },
      { name: 'empty.txt', body: '' },
    ])
    expect(directory(archive).map((e) => e.name)).toEqual(['warp/P1.data', 'warp/Projektor-ü.data', 'empty.txt'])
    expect(entryText(archive, 'warp/Projektor-ü.data')).toBe('two')
    expect(entryText(archive, 'empty.txt')).toBe('')
    const entry = directory(archive)[0]
    const read = readStoredEntry(archive, entry)
    expect(read.ok && read.bytes.buffer).toBe(archive.buffer)
  })

  it('reads an archive with no entries', () => {
    expect(directory(writeZip([]))).toEqual([])
  })

  it('finds the end record past a comment, and not the signature inside one', () => {
    // A whole end record's worth of bytes, but its comment length (0) does
    // not reach the end of the file, since more comment follows it.
    const decoy = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const comment = Uint8Array.from([...enc.encode('note '), ...decoy, ...enc.encode(' and more')])
    const archive = writeZip([{ name: 'a.txt', body: 'a' }], { comment })
    expect(entryText(archive, 'a.txt')).toBe('a')
  })

  it('refuses rather than guesses when a comment ends in a plausible end record', () => {
    // The format cannot tell this from a real record with an empty comment;
    // the directory it points at does not add up, and that is refused.
    const decoy = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const archive = writeZip([{ name: 'a.txt', body: 'a' }], { comment: decoy })
    expect(directoryRefusal(archive).code).toBe('corrupt')
  })

  it('refuses what is not an archive, or not one any more', () => {
    const whole = writeZip([{ name: 'a.txt', body: 'a' }])
    expect(directoryRefusal(enc.encode('2\n41 41\n')).code).toBe('not-a-zip')
    expect(directoryRefusal(new Uint8Array(0)).code).toBe('not-a-zip')
    expect(directoryRefusal(whole.subarray(0, whole.length - 1)).code).toBe('not-a-zip')
    expect(directoryRefusal(writeZip([{ name: 'a.txt', body: 'a' }], { trailing: Uint8Array.of(0) })).code).toBe(
      'not-a-zip',
    )
  })

  it('refuses ZIP64, whether announced by a locator or by sentinels', () => {
    expect(directoryRefusal(writeZip([{ name: 'a.txt', body: 'a' }], { zip64Locator: true })).code).toBe('zip64')
    expect(directoryRefusal(writeZip([], { entryCount: 0xffff })).code).toBe('zip64')
    expect(directoryRefusal(writeZip([{ name: 'a.txt', body: 'a', size: 0xffffffff }])).code).toBe('zip64')
  })

  it('refuses a spanned archive', () => {
    expect(directoryRefusal(writeZip([{ name: 'a.txt', body: 'a' }], { disk: 1 })).code).toBe('multi-volume')
  })

  it('refuses a directory that does not end where the end record begins', () => {
    // A self-extractor's stub shifts everything its offsets do not count.
    const stubbed = writeZip([{ name: 'a.txt', body: 'a' }], { prefix: enc.encode('MZ stub') })
    expect(directoryRefusal(stubbed).code).toBe('corrupt')
    // One more record claimed than written.
    expect(directoryRefusal(writeZip([{ name: 'a.txt', body: 'a' }], { entryCount: 2 })).code).toBe('corrupt')
  })

  it('refuses a directory record that is not one', () => {
    const archive = writeZip([{ name: 'a.txt', body: 'a' }])
    const broken = archive.slice()
    // The directory's one record starts right before the 22-byte end record.
    broken[archive.length - 22 - (46 + 'a.txt'.length)] = 0
    expect(directoryRefusal(broken).code).toBe('corrupt')
  })
})

describe('readStoredEntry', () => {
  it('refuses a compressed entry without refusing the stored ones beside it', () => {
    const archive = writeZip([
      { name: 'README.txt', body: 'deflated, supposedly', method: 8 },
      { name: 'warp/P1.data', body: 'stored' },
    ])
    expect(directory(archive)).toHaveLength(2)
    expect(entryRefusal(archive, 'README.txt')).toMatchObject({ code: 'compressed', entry: 'README.txt' })
    expect(entryText(archive, 'warp/P1.data')).toBe('stored')
  })

  it('refuses an encrypted entry', () => {
    expect(entryRefusal(writeZip([{ name: 'a.txt', body: 'a', flags: 0x1 }]), 'a.txt').code).toBe('encrypted')
  })

  it('refuses bytes that do not match their checksum', () => {
    const archive = writeZip([{ name: 'warp/P1.data', body: '0.500000 0.250000' }])
    const flipped = archive.slice()
    const at = 30 + 'warp/P1.data'.length + 2
    flipped[at] = flipped[at] === 0x35 ? 0x36 : 0x35
    expect(entryRefusal(flipped, 'warp/P1.data')).toMatchObject({ code: 'checksum', entry: 'warp/P1.data' })
    expect(entryRefusal(writeZip([{ name: 'a.txt', body: 'a', crc: 0x12345678 }]), 'a.txt').code).toBe('checksum')
  })

  it('refuses a local header that disagrees with the directory', () => {
    expect(entryRefusal(writeZip([{ name: 'warp/P1.data', body: 'a', localName: 'warp/P2.data' }]), 'warp/P1.data').code).toBe(
      'corrupt',
    )
    expect(entryRefusal(writeZip([{ name: 'a.txt', body: 'a', localMethod: 8 }]), 'a.txt').code).toBe('corrupt')
  })

  it('refuses a stored entry whose sizes disagree, or that runs past the archive', () => {
    expect(entryRefusal(writeZip([{ name: 'a.txt', body: 'abc', compressedSize: 2 }]), 'a.txt').code).toBe('corrupt')
    const long = writeZip([{ name: 'a.txt', body: 'abc', size: 4000, compressedSize: 4000 }])
    expect(entryRefusal(long, 'a.txt').code).toBe('corrupt')
  })

  it('reads a streamed entry by the directory\'s sizes, past a data descriptor', () => {
    const archive = writeZip([
      { name: 'first.data', body: 'streamed', descriptor: true },
      { name: 'second.data', body: 'after it' },
    ])
    expect(entryText(archive, 'first.data')).toBe('streamed')
    expect(entryText(archive, 'second.data')).toBe('after it')
  })

  it('finds the data past a local extra field the directory does not carry', () => {
    const archive = writeZip([{ name: 'a.txt', body: 'payload', localExtra: Uint8Array.of(0x55, 0x54, 5, 0, 1, 0, 0, 0, 0) }])
    expect(entryText(archive, 'a.txt')).toBe('payload')
  })
})
