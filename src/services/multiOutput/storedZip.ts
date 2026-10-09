// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A reader for **store-only** ZIP archives — the container sphere-sim
 * writes its warp bundle in (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16",
 * "Where the meshes live"), and nothing more general than that.
 *
 * sphere-sim's writer (`packages/web/src/zip.ts`) stores every entry as
 * method 0 — the bytes go in as they are — with a CRC-32, no extra fields
 * and the UTF-8 name flag set. Reading that back is a directory walk and
 * a checksum, which is why this is a page of code and not a dependency.
 * The repo does ship JSZip, but for the web-only dataset download, and
 * its own docstring keeps it out of the desktop bundle deliberately: an
 * import that only a desktop operator can reach is the wrong reason to
 * put it back.
 *
 * **Fail-closed, like the mesh parse behind it.** Anything this reader
 * cannot account for byte by byte is refused with a code rather than
 * read optimistically: a directory that does not end where its record
 * says, an offset outside the file, a local header whose name disagrees
 * with the directory's, a checksum that does not match. A calibration
 * that arrives damaged still parses as numbers often enough to be
 * dangerous — the mesh parse refuses a short file, but not a byte flipped
 * inside a coordinate — so the CRC is checked on every entry read, not
 * trusted.
 *
 * **Compressed entries are refused, not inflated.** An operator who
 * extracted the bundle and zipped it again with their OS gets deflate,
 * and inflating it would take a decompressor this app does not carry for
 * a case with a better way through: pick the extracted `.data` files
 * instead. So `compressed` is a refusal the panel words as exactly that.
 * It is refused per entry, on read, because only the entries a caller
 * asks for need to be stored — a `README.txt` someone recompressed does
 * not make the meshes beside it unreadable.
 *
 * ZIP64, spanned archives and encryption are refused outright: a warp
 * bundle is a few hundred kilobytes and none of them can arise from the
 * writer this exists to read.
 *
 * Pure: no DOM, no fetch, no timers. `TextDecoder` is the one platform
 * object, and it exists in every runtime this code reaches.
 */

/** Why an archive, or one entry of it, could not be read. */
export type StoredZipRefusalCode =
  /** No end-of-central-directory record: not a ZIP, or cut short. */
  | 'not-a-zip'
  /** Split across volumes, which a single file cannot be read as. */
  | 'multi-volume'
  /** Sizes, offsets or counts that need ZIP64 — nothing sphere-sim writes. */
  | 'zip64'
  /** A structural field that does not add up: the archive is damaged. */
  | 'corrupt'
  /** An entry stored with a method other than 0 — recompressed after export. */
  | 'compressed'
  /** An encrypted entry. */
  | 'encrypted'
  /** An entry whose bytes do not match its CRC-32: damaged in transit. */
  | 'checksum'

export interface StoredZipRefusal {
  readonly code: StoredZipRefusalCode
  /** The entry to blame, when one is. */
  readonly entry?: string
  /** For a developer reading a log. */
  readonly detail: string
}

/** One central-directory record — what the archive says an entry is. */
export interface ZipDirectoryEntry {
  readonly name: string
  /** 0 is stored; anything else is compressed and refused on read. */
  readonly method: number
  /** General-purpose bit 0. */
  readonly encrypted: boolean
  readonly crc32: number
  readonly compressedSize: number
  readonly size: number
  readonly localHeaderOffset: number
  /** The name as stored, compared byte for byte against the local header's. */
  readonly nameBytes: Uint8Array
}

export type ZipDirectoryResult =
  | { readonly ok: true; readonly entries: readonly ZipDirectoryEntry[] }
  | { readonly ok: false; readonly refusal: StoredZipRefusal }

export type StoredEntryResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly refusal: StoredZipRefusal }

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50

const END_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
const ZIP64_LOCATOR_SIZE = 20
/** The largest archive comment, and so how far back the end record can sit. */
const MAX_COMMENT = 0xffff

const FLAG_ENCRYPTED = 0x1

let CRC_TABLE: Uint32Array | null = null

/**
 * CRC-32, the reflected polynomial ZIP uses. The table is built on first
 * use rather than at load, since most sessions never import a warp.
 */
export function crc32(bytes: Uint8Array): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  const table = CRC_TABLE
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8)
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
}

function refused(code: StoredZipRefusalCode, detail: string, entry?: string): { ok: false; refusal: StoredZipRefusal } {
  return { ok: false, refusal: entry === undefined ? { code, detail } : { code, entry, detail } }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The end-of-central-directory record's offset, or `-1`. Searched from
 * the end, and accepted only where its own comment length reaches the
 * end of the file exactly — the signature's four bytes can sit inside a
 * comment, and trailing bytes after a real record mean the file is not
 * what it claims to be.
 */
function findEnd(archive: Uint8Array): number {
  const lowest = Math.max(0, archive.length - END_SIZE - MAX_COMMENT)
  for (let p = archive.length - END_SIZE; p >= lowest; p--) {
    if (u32(archive, p) === SIG_END && p + END_SIZE + u16(archive, p + 20) === archive.length) return p
  }
  return -1
}

/**
 * Read the central directory: every entry's name, method and extent,
 * validated as structure. No entry's bytes are touched — that is
 * `readStoredEntry`, for the entries a caller actually wants.
 *
 * Names are decoded as UTF-8 whatever the flag says. sphere-sim sets the
 * flag, and the only names a caller here matches are ASCII, where UTF-8
 * and the legacy code page agree; a name in anything else decodes to
 * replacement characters and matches nothing.
 */
export function readZipDirectory(archive: Uint8Array): ZipDirectoryResult {
  const end = findEnd(archive)
  if (end < 0) return refused('not-a-zip', 'no end-of-central-directory record')

  // A ZIP64 archive carries a locator immediately before the classic
  // record, whose fields may then be sentinels or may look plausible.
  if (end >= ZIP64_LOCATOR_SIZE && u32(archive, end - ZIP64_LOCATOR_SIZE) === SIG_ZIP64_LOCATOR) {
    return refused('zip64', 'the archive carries a ZIP64 end record')
  }
  const disk = u16(archive, end + 4)
  const directoryDisk = u16(archive, end + 6)
  const entriesHere = u16(archive, end + 8)
  const entryCount = u16(archive, end + 10)
  const directorySize = u32(archive, end + 12)
  const directoryOffset = u32(archive, end + 16)
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return refused('zip64', 'the end record holds ZIP64 sentinels')
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesHere !== entryCount) {
    return refused('multi-volume', `disk ${disk}, directory on disk ${directoryDisk}`)
  }
  // The directory must end exactly where the end record begins. Anything
  // between them is a record this reader does not know; anything before
  // the offsets' origin is a stub (a self-extractor) the offsets ignore.
  if (directoryOffset + directorySize !== end) {
    return refused('corrupt', `the directory spans ${directoryOffset}+${directorySize}, the end record sits at ${end}`)
  }

  const decoder = new TextDecoder('utf-8')
  const entries: ZipDirectoryEntry[] = []
  let q = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (q + CENTRAL_SIZE > end || u32(archive, q) !== SIG_CENTRAL) {
      return refused('corrupt', `directory record ${i} is missing or malformed`)
    }
    const flags = u16(archive, q + 8)
    const method = u16(archive, q + 10)
    const crc = u32(archive, q + 16)
    const compressedSize = u32(archive, q + 20)
    const size = u32(archive, q + 24)
    const nameLength = u16(archive, q + 28)
    const extraLength = u16(archive, q + 30)
    const commentLength = u16(archive, q + 32)
    const startDisk = u16(archive, q + 34)
    const localHeaderOffset = u32(archive, q + 42)
    const next = q + CENTRAL_SIZE + nameLength + extraLength + commentLength
    if (next > end) return refused('corrupt', `directory record ${i} runs past the directory`)
    const nameBytes = archive.subarray(q + CENTRAL_SIZE, q + CENTRAL_SIZE + nameLength)
    const name = decoder.decode(nameBytes)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      return refused('zip64', 'an entry needs ZIP64 sizes or offsets', name)
    }
    if (startDisk !== 0) return refused('multi-volume', `the entry starts on disk ${startDisk}`, name)
    if (localHeaderOffset + LOCAL_SIZE > directoryOffset) {
      return refused('corrupt', `the local header offset ${localHeaderOffset} is outside the data`, name)
    }
    entries.push({
      name,
      method,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      crc32: crc,
      compressedSize,
      size,
      localHeaderOffset,
      nameBytes,
    })
    q = next
  }
  if (q !== end) return refused('corrupt', `the directory holds ${end - q} bytes past its ${entryCount} records`)
  return { ok: true, entries }
}

/**
 * One entry's bytes — a view into the archive, not a copy — or why not.
 *
 * The local header is read only to find where the data starts, since its
 * extra field may differ in length from the directory's. Its name must
 * match the directory's byte for byte, so two directory records cannot
 * alias one entry's data under two names. Sizes, method and checksum come
 * from the directory, which is what a writer that streams (general-purpose
 * bit 3) leaves authoritative.
 */
export function readStoredEntry(archive: Uint8Array, entry: ZipDirectoryEntry): StoredEntryResult {
  if (entry.encrypted) return refused('encrypted', 'the entry is encrypted', entry.name)
  if (entry.method !== 0) return refused('compressed', `method ${entry.method}; only stored entries are read`, entry.name)
  if (entry.compressedSize !== entry.size) {
    return refused('corrupt', `a stored entry of ${entry.size} bytes claims ${entry.compressedSize} compressed`, entry.name)
  }
  const at = entry.localHeaderOffset
  if (at + LOCAL_SIZE > archive.length || u32(archive, at) !== SIG_LOCAL) {
    return refused('corrupt', 'no local header where the directory points', entry.name)
  }
  if (u16(archive, at + 8) !== 0) {
    return refused('corrupt', 'the local header disagrees with the directory about the method', entry.name)
  }
  const nameLength = u16(archive, at + 26)
  const extraLength = u16(archive, at + 28)
  if (!sameBytes(archive.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLength), entry.nameBytes)) {
    return refused('corrupt', 'the local header names a different file', entry.name)
  }
  const start = at + LOCAL_SIZE + nameLength + extraLength
  const stop = start + entry.size
  if (stop > archive.length) return refused('corrupt', 'the data runs past the end of the archive', entry.name)
  const bytes = archive.subarray(start, stop)
  const actual = crc32(bytes)
  if (actual !== entry.crc32) {
    return refused('checksum', `CRC-32 ${actual.toString(16)} where the directory says ${entry.crc32.toString(16)}`, entry.name)
  }
  return { ok: true, bytes }
}
