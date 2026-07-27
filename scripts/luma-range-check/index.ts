/**
 * Verifies that an 8-bit value survives the H.264 round trip intact —
 * the precondition for `docs/DATA_ENCODED_VIDEO_PLAN.md`, where luma
 * *is* the normalised data value rather than a picture of it.
 *
 * A colour-range mismatch is total failure rather than degradation: it
 * shifts every value by 16/255 ≈ 0.063, which is larger than the smoke
 * palette's entire `transparent_range` of 12/256 ≈ 0.047. So "no data"
 * stops being transparent everywhere at once.
 *
 * The check encodes a 0..255 luma ramp through this repo's exact ladder
 * settings, plays it in a browser, and samples it back through both
 * paths the design relies on:
 *
 *   - **render path** — video → WebGL texture → `readPixels`
 *   - **readout path** — the 1×1 `drawImage` the hover probe uses
 *
 * A variant passes only if the recovered value equals the source within
 * one 8-bit step *and* the fitted transform is the identity. Gain ≠ 1 or
 * offset ≠ 0 is the signature of a range mismatch.
 *
 * Usage:
 *   npx tsx scripts/luma-range-check            # encode + run headless
 *   npx tsx scripts/luma-range-check --serve    # serve for a real device
 *
 * `--serve` exists because Safari and iOS Safari cannot be driven from
 * CI here; it prints a LAN URL to open on the device under test.
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAMES = join(HERE, '.frames')
const OUT = join(HERE, 'out')
const BAND_W = 16
const WIDTH = 256 * BAND_W // 4096 — the spherical rung's width
const HEIGHT = 256
const FRAME_COUNT = 12

/**
 * The four encoder configurations worth distinguishing. `A_today` is
 * what `cli/lib/ffmpeg-hls.ts` emits right now; the rest are candidate
 * fixes. `B_tag_only` is included precisely because it is the obvious
 * fix and it does not work — `-color_range pc` retags the stream
 * without changing what swscale actually writes, which manufactures the
 * mismatch it was meant to prevent.
 */
const VARIANTS: ReadonlyArray<{ name: string; vf?: string; extra: string[]; note: string }> = [
  { name: 'A_today', extra: [], note: "today's settings — no colour flags at all" },
  {
    name: 'B_tag_only',
    extra: ['-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=pc'],
    note: 'retag only — the naive fix, expected to FAIL',
  },
  {
    name: 'C_limited', vf: 'scale=in_range=full:out_range=limited',
    extra: ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv'],
    note: 'consistent limited range — survives, but only 219 code levels',
  },
  {
    name: 'D_full_proper', vf: 'scale=in_range=full:out_range=full',
    extra: ['-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=pc'],
    note: 'conversion AND tag both full range — the recommended setting',
  },
]

// --- PNG writing (grayscale, colour type 0) ------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function grayPng(w: number, h: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type 0 = grayscale
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter type: none, so the bytes stay verbatim
    pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 256 flat bands, one per code value — flat so that neither chroma
 *  subsampling nor DCT ringing contaminates the sample at a band centre. */
function writeFrames(): void {
  mkdirSync(FRAMES, { recursive: true })
  const row = Buffer.alloc(WIDTH)
  for (let v = 0; v < 256; v++) row.fill(v, v * BAND_W, (v + 1) * BAND_W)
  const px = Buffer.alloc(WIDTH * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) row.copy(px, y * WIDTH)
  const png = grayPng(WIDTH, HEIGHT, px)
  for (let f = 1; f <= FRAME_COUNT; f++) {
    writeFileSync(join(FRAMES, `f${String(f).padStart(4, '0')}.png`), png)
  }
}

// --- encoding ------------------------------------------------------------

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN ?? 'ffmpeg'
}

/** Ladder settings copied from `buildFfmpegArgs` in `cli/lib/ffmpeg-hls.ts`. */
const LADDER = ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
                '-preset', 'slow', '-crf', '18', '-an']

function encodeAll(): void {
  mkdirSync(OUT, { recursive: true })
  for (const v of VARIANTS) {
    const args = ['-y', '-framerate', '30', '-i', join(FRAMES, 'f%04d.png')]
    if (v.vf) args.push('-vf', v.vf)
    args.push(...LADDER, ...v.extra, join(OUT, `${v.name}.mp4`))
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`ffmpeg failed for ${v.name}:\n${r.stderr?.slice(-2000) ?? r.error}`)
    }
    process.stdout.write(`  encoded ${v.name.padEnd(14)} ${v.note}\n`)
  }
}

// --- serving -------------------------------------------------------------

const MIME: Record<string, string> = { '.html': 'text/html', '.mp4': 'video/mp4' }

function serve(port: number): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
    const p = join(HERE, rel === '/' ? 'page.html' : rel)
    if (!p.startsWith(HERE) || !existsSync(p)) {
      res.writeHead(404)
      return res.end('not found')
    }
    const body = readFileSync(p)
    res.writeHead(200, {
      'Content-Type': MIME[extname(p)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    })
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(port, '0.0.0.0', () =>
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }))
  })
}

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) return ni.address
  }
  return 'localhost'
}

// --- main ----------------------------------------------------------------

interface Row {
  name: string
  path?: string
  error?: string
  exact?: number
  mae?: number
  maxAbs?: number
  gain?: number
  offset?: number
  v0?: number
  v255?: number
  pass?: boolean
  glRenderer?: string
}

async function main(): Promise<void> {
  const serveOnly = process.argv.includes('--serve')

  process.stdout.write('Generating ramp frames…\n')
  writeFrames()
  process.stdout.write('Encoding variants…\n')
  encodeAll()

  const { port, close } = await serve(serveOnly ? 8791 : 0)
  const names = VARIANTS.map(v => v.name)

  if (serveOnly) {
    process.stdout.write(
      `\nOpen this on the device under test (Safari / iOS Safari / Firefox):\n\n` +
      `    http://${lanAddress()}:${port}/page.html\n\n` +
      `Press "Run check". Every row must read PASS.\nCtrl-C to stop.\n`)
    return
  }

  const { chromium, firefox, webkit } = await import('playwright')
  const engine = process.env.LUMA_BROWSER ?? 'chromium'
  const launcher = engine === 'firefox' ? firefox : engine === 'webkit' ? webkit : chromium
  // Playwright's bundled Chromium is the open-source build and has NO
  // proprietary codecs — it reports `canPlayType` empty for every H.264
  // profile. Point LUMA_BROWSER_PATH at a real Chrome/Edge to test H.264.
  const executablePath = process.env.LUMA_BROWSER_PATH
  const browser = await launcher.launch({
    ...(executablePath ? { executablePath } : {}),
    args: engine === 'chromium'
      ? ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         '--enable-unsafe-swiftshader', '--use-angle=swiftshader']
      : [],
  })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/page.html`)
  const rows = (await page.evaluate(
    n => (window as unknown as { runCheck: (v: string[]) => Promise<Row[]> }).runCheck(n),
    names,
  )) as Row[]
  await browser.close()
  close()

  process.stdout.write(
    `\n${'variant'.padEnd(15)}${'path'.padEnd(9)}${'exact'.padEnd(9)}` +
    `${'MAE'.padEnd(8)}${'max|e|'.padEnd(8)}${'gain'.padEnd(9)}${'offset'.padEnd(9)}0→   255→\n`)
  let failed = false
  for (const r of rows) {
    if (r.error) {
      process.stdout.write(`${r.name.padEnd(15)}${(r.path ?? '').padEnd(9)}ERROR: ${r.error}\n`)
      failed = true
      continue
    }
    const verdict = r.pass ? 'PASS' : 'FAIL'
    process.stdout.write(
      `${r.name.padEnd(15)}${(r.path ?? '').padEnd(9)}${`${r.exact}/256`.padEnd(9)}` +
      `${r.mae!.toFixed(3).padEnd(8)}${String(r.maxAbs).padEnd(8)}` +
      `${r.gain!.toFixed(4).padEnd(9)}${r.offset!.toFixed(2).padEnd(9)}` +
      `${String(r.v0).padEnd(5)}${String(r.v255).padEnd(6)}${verdict}\n`)
    // Only the recommended setting is required to pass; B_tag_only is
    // expected to fail and its failure is the point of including it.
    if (r.name === 'D_full_proper' && !r.pass) failed = true
  }
  if (rows.length) process.stdout.write(`\nGL: ${rows.find(r => r.glRenderer)?.glRenderer ?? 'n/a'}\n`)
  if (failed) {
    process.stdout.write('\nFAILED — the recommended encoder setting did not round-trip.\n')
    process.exitCode = 1
  } else {
    process.stdout.write('\nOK — luma survives the round trip under D_full_proper.\n')
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
