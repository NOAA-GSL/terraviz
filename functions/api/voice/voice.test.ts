// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../../../src/types/node-features'
import { NODE_FEATURES_CACHE_KEY } from '../v1/_lib/node-settings-store'
import { makeKV } from '../v1/_lib/test-helpers'
import { onRequestPost as transcribe } from './transcribe'
import { onRequestPost as synthesize } from './synthesize'
import { isVoiceKilled, arrayBufferToBase64, isAllowedOrigin, type VoiceEnv } from './_voice-lib'
import { streamConfigured, buildGatewayUrl, streamRefusal, onRequest as stream } from './stream'
import { resetOrbitGateForTests } from '../_lib/orbit-gate'

// The gate memoises per module instance; each case starts cold.
beforeEach(resetOrbitGateForTests)

const ORIGIN = 'https://preview.terraviz.pages.dev'
const URL_T = `${ORIGIN}/api/voice/transcribe`
const URL_S = `${ORIGIN}/api/voice/synthesize`

function ctx(request: Request, env: VoiceEnv) {
  return { request, env } as unknown as Parameters<typeof transcribe>[0]
}

/**
 * Build a fake Request. `Origin` is a forbidden request header so it
 * can't be set on a real `Request` in Node — mirror ingest.test and
 * hand-roll the bits the handlers read.
 */
function fakeReq(opts: {
  url: string
  origin?: string | null
  headers?: Record<string, string>
  arrayBuffer?: ArrayBuffer
  json?: unknown
}): Request {
  const h = new Map<string, string>()
  if (opts.origin) h.set('origin', opts.origin)
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k.toLowerCase(), v)
  return {
    url: opts.url,
    headers: {
      get: (n: string) => h.get(n.toLowerCase()) ?? null,
      has: (n: string) => h.has(n.toLowerCase()),
    },
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
    json: async () => opts.json,
  } as unknown as Request
}

function aiOk(result: Record<string, unknown>): VoiceEnv {
  return { AI: { run: async () => result } }
}

describe('_voice-lib', () => {
  it('isVoiceKilled honours deny values only', () => {
    expect(isVoiceKilled({ KILL_VOICE: '1' })).toBe(true)
    expect(isVoiceKilled({ KILL_VOICE: 'TRUE' })).toBe(true)
    expect(isVoiceKilled({ KILL_VOICE: 'off' })).toBe(false)
    expect(isVoiceKilled({})).toBe(false)
  })

  it('isAllowedOrigin accepts same-origin + localhost, rejects others', () => {
    expect(isAllowedOrigin(ORIGIN, URL_T)).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173', URL_T)).toBe(true)
    expect(isAllowedOrigin('https://evil.example', URL_T)).toBe(false)
    expect(isAllowedOrigin(null, URL_T)).toBe(false)
  })

  it('arrayBufferToBase64 round-trips through atob', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255])
    const b64 = arrayBufferToBase64(bytes.buffer)
    const back = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    expect([...back]).toEqual([...bytes])
  })
})

describe('transcribe', () => {
  const audio = new Uint8Array([1, 2, 3, 4]).buffer
  const req = (env: VoiceEnv, body: ArrayBuffer = audio, origin: string | null = ORIGIN) =>
    transcribe(ctx(fakeReq({ url: URL_T, origin, arrayBuffer: body }), env))

  it('rejects a foreign origin with 403', async () => {
    const res = await req(aiOk({ text: 'x' }), audio, 'https://evil.example')
    expect(res.status).toBe(403)
  })

  it('returns 503 voice_disabled when KILL_VOICE is set', async () => {
    const res = await req({ ...aiOk({ text: 'x' }), KILL_VOICE: '1' })
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_disabled')
  })

  it('returns 503 voice_unavailable when the AI binding is absent', async () => {
    const res = await req({})
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_unavailable')
  })

  it('400s on empty audio', async () => {
    const res = await req(aiOk({ text: 'x' }), new ArrayBuffer(0))
    expect(res.status).toBe(400)
  })

  it('transcribes audio to { text }', async () => {
    const res = await req(aiOk({ text: 'show me sea ice' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'show me sea ice' })
  })
})

describe('synthesize', () => {
  const req = (env: VoiceEnv, body: unknown, origin: string | null = ORIGIN) =>
    synthesize(ctx(fakeReq({ url: URL_S, origin, json: body }), env))

  it('400s when text is missing', async () => {
    const res = await req(aiOk({ audio: 'AAA' }), {})
    expect(res.status).toBe(400)
  })

  it('returns base64 audio for valid text (MeloTTS default)', async () => {
    let usedModel = ''
    const env: VoiceEnv = { AI: { run: async (m) => { usedModel = m; return { audio: 'QUJD' } } } }
    const res = await req(env, { text: 'Hello there.', lang: 'en-US' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ audio: 'QUJD', format: 'mp3' })
    expect(usedModel).toBe('@cf/myshell-ai/melotts')
  })

  it('routes to Aura when model: aura is requested', async () => {
    let usedModel = ''
    const env: VoiceEnv = { AI: { run: async (m) => { usedModel = m; return { audio: 'QUJD' } } } }
    await req(env, { text: 'Hi', model: 'aura' })
    expect(usedModel).toBe('@cf/deepgram/aura-1')
  })

  it('returns 503 when KILL_VOICE is set', async () => {
    const res = await req({ ...aiOk({ audio: 'AAA' }), KILL_VOICE: 'true' }, { text: 'Hi' })
    expect(res.status).toBe(503)
  })
})

describe('the node orbit feature gate', () => {
  /** A catalog KV whose cached feature map has Orbit turned off. */
  function orbitOff(): Pick<VoiceEnv, 'CATALOG_KV'> {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify({ ...defaultFeatures(), orbit: false }))
    return { CATALOG_KV: kv }
  }

  it('transcribe answers 403 feature_disabled and never runs the model', async () => {
    const run = vi.fn(async () => ({ text: 'x' }))
    const res = await transcribe(ctx(
      fakeReq({ url: URL_T, origin: ORIGIN, arrayBuffer: new Uint8Array([1, 2]).buffer }),
      { AI: { run }, ...orbitOff() },
    ))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('feature_disabled')
    expect(run).not.toHaveBeenCalled()
  })

  it('synthesize answers 403 feature_disabled and never runs the model', async () => {
    const run = vi.fn(async () => ({ audio: 'QUJD' }))
    const res = await synthesize(ctx(
      fakeReq({ url: URL_S, origin: ORIGIN, json: { text: 'Hi' } }),
      { AI: { run }, ...orbitOff() },
    ))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('feature_disabled')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves KILL_VOICE in charge when both apply', async () => {
    // The kill switch carries the Retry-After the client cools down
    // on; the gate must not shadow it.
    const res = await synthesize(ctx(
      fakeReq({ url: URL_S, origin: ORIGIN, json: { text: 'Hi' } }),
      { ...aiOk({ audio: 'AAA' }), KILL_VOICE: '1', ...orbitOff() },
    ))
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_disabled')
  })

  it('refuses a foreign origin before reading the feature map', async () => {
    const env = { ...aiOk({ text: 'x' }), ...orbitOff() }
    const res = await transcribe(ctx(fakeReq({ url: URL_T, origin: 'https://evil.example' }), env))
    expect(res.status).toBe(403)
    expect(env.CATALOG_KV!.get).not.toHaveBeenCalled()
  })
})

describe('voice stream refusal order', () => {
  const CONFIGURED = { CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't' }
  const offKv = () => {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify({ ...defaultFeatures(), orbit: false }))
    return kv
  }

  it('opens for a configured node with Orbit on', async () => {
    expect(await streamRefusal(CONFIGURED, 'ip', () => false)).toBeNull()
  })

  it('refuses with feature_disabled and spends no rate allowance while Orbit is off', async () => {
    const limiter = vi.fn(() => false)
    expect(await streamRefusal({ ...CONFIGURED, CATALOG_KV: offKv() }, 'ip', limiter)).toBe('feature_disabled')
    expect(limiter).not.toHaveBeenCalled()
  })

  it('says feature_disabled rather than unconfigured on a node with neither', async () => {
    expect(await streamRefusal({ CATALOG_KV: offKv() }, 'ip', () => false)).toBe('feature_disabled')
  })

  it('leaves KILL_VOICE in charge when both apply', async () => {
    expect(await streamRefusal({ ...CONFIGURED, KILL_VOICE: '1', CATALOG_KV: offKv() }, 'ip', () => false))
      .toBe('voice_disabled')
  })

  it('refuses a foreign origin before reading the feature map', async () => {
    const kv = offKv()
    const request = fakeReq({
      url: `${ORIGIN}/api/voice/stream`,
      origin: 'https://evil.example',
      headers: { Upgrade: 'websocket' },
    })
    const res = await stream({ request, env: { ...CONFIGURED, CATALOG_KV: kv } } as unknown as Parameters<typeof stream>[0])
    expect(res.status).toBe(403)
    expect(kv.get).not.toHaveBeenCalled()
  })
})

describe('voice stream proxy helpers', () => {
  it('streamConfigured requires all three gateway settings', () => {
    expect(streamConfigured({})).toBe(false)
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g' })).toBe(false)
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't' })).toBe(true)
    // Whitespace-only counts as unset — otherwise the deploy looks
    // configured and every socket dies at the gateway instead.
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: '  ' })).toBe(
      false,
    )
  })

  it('buildGatewayUrl targets Nova-3 linear16 16k with interim results + language', () => {
    const url = buildGatewayUrl({ CF_ACCOUNT_ID: 'acct', CF_AI_GATEWAY: 'gw', CF_AIG_TOKEN: 't' }, 'es-MX')
    expect(url).toContain('wss://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai?')
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fnova-3')
    expect(url).toContain('encoding=linear16')
    expect(url).toContain('sample_rate=16000')
    expect(url).toContain('interim_results=true')
    expect(url).toContain('language=es') // base language only
  })

  it('buildGatewayUrl honours a model override', () => {
    const url = buildGatewayUrl({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't', VOICE_STREAM_MODEL: '@cf/deepgram/flux' }, 'en')
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fflux')
  })

  it('buildGatewayUrl trims the account id, gateway name, and model', () => {
    // These land in the URL path, where a trailing newline routes
    // the socket somewhere that does not exist.
    const url = buildGatewayUrl(
      { CF_ACCOUNT_ID: ' acct\n', CF_AI_GATEWAY: 'gw ', CF_AIG_TOKEN: 't', VOICE_STREAM_MODEL: ' @cf/deepgram/flux\n' },
      'en',
    )
    expect(url).toContain('wss://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai?')
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fflux')
  })
})
