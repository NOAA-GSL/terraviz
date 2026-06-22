/**
 * Realtime WebSocket streaming STT engine (Phase 3) — live interim
 * transcripts over Cloudflare's Deepgram Nova-3/Flux endpoint.
 *
 * Unlike the batch `cloudStreamingSttEngine` (record → Whisper, no
 * partials), this opens a WebSocket to our own `/api/voice/stream`
 * proxy (which adds the `cf-aig-authorization` secret and connects on
 * to the AI Gateway — the key never reaches the client), streams
 * **linear16 PCM** from the mic, and emits `onPartial` for interim
 * results and `onTurn` when Deepgram marks a result `is_final`.
 *
 * The socket and the Web Audio capture are injectable seams so the
 * message/transport logic is unit-testable without real audio or a
 * live gateway (§10.3). Registered as the `cloud` streaming provider
 * when available; falls back to the batch engine otherwise.
 * (docs/ORBIT_VOICE_PLAN.md §3 realtime path, §10.1)
 */
import {
  type StreamingSttEngine,
  type VoiceCapabilities,
} from './voiceService'
import { downsampleTo16kHz, floatToLinear16, parseDeepgramMessage } from './voicePcm'
import { baseLanguage, CLOUD_STT_LANGUAGES } from './voiceService'
import { logger } from '../utils/logger'

/** Minimal WebSocket surface (injectable for tests). */
export interface WsLike {
  binaryType: string
  readyState: number
  send(data: ArrayBuffer | string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev?: unknown) => void) | null
  onclose: ((ev?: unknown) => void) | null
}
export type CreateSocket = (url: string) => WsLike

/** A running PCM capture; `stop()` tears down the audio graph. */
export interface PcmCapture { stop(): void }
/** Pump linear16 PCM frames from a mic stream into `onFrame`. */
export type StartPcmCapture = (stream: MediaStream, onFrame: (pcm: ArrayBuffer) => void) => PcmCapture

const STREAM_PATH = '/api/voice/stream'

/** Build the same-origin `wss://…/api/voice/stream` URL for a locale. */
export function buildStreamUrl(lang: string): string {
  if (typeof location === 'undefined') return STREAM_PATH
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const q = lang ? `?lang=${encodeURIComponent(baseLanguage(lang))}` : ''
  return `${proto}//${location.host}${STREAM_PATH}${q}`
}

const defaultCreateSocket: CreateSocket = (url) => new WebSocket(url) as unknown as WsLike

/** Default Web Audio capture: Float32 → 16 kHz → linear16 frames. */
const defaultStartPcmCapture: StartPcmCapture = (stream, onFrame) => {
  const w = window as unknown as Record<string, unknown>
  const Ctx = (w['AudioContext'] ?? w['webkitAudioContext']) as (new () => AudioContext) | undefined
  if (!Ctx) return { stop: () => {} }
  const ctx = new Ctx()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it
  // needs no separate worklet module and is universally supported — a
  // pragmatic first cut; AudioWorklet is a later refinement.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0)
    onFrame(floatToLinear16(downsampleTo16kHz(input, ctx.sampleRate)))
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  return {
    stop: () => {
      try { processor.disconnect(); source.disconnect(); void ctx.close() } catch { /* already torn down */ }
    },
  }
}

export interface WsStreamingEngineDeps {
  createSocket?: CreateSocket
  startCapture?: StartPcmCapture
}

/**
 * Build the realtime WS streaming engine. The deps default to the real
 * WebSocket + Web Audio; tests inject fakes.
 */
export function createWsStreamingSttEngine(deps: WsStreamingEngineDeps = {}): StreamingSttEngine {
  const createSocket = deps.createSocket ?? defaultCreateSocket
  const startCapture = deps.startCapture ?? defaultStartPcmCapture
  return {
    provider: 'cloud',
    supportsLanguage: (lang) => CLOUD_STT_LANGUAGES.has(baseLanguage(lang)),
    // Needs Web Audio + a live mic stream (the session provides it) and
    // a same-origin proxy — so web-only, like the batch cloud engine.
    isAvailable: (caps: VoiceCapabilities) => caps.getUserMedia && typeof WebSocket !== 'undefined',
    startStreaming: ({ lang, stream, onPartial, onTurn, onError, onEnd }) => {
      let closed = false
      let capture: PcmCapture | null = null
      let socket: WsLike | null = null

      const teardown = (): void => {
        capture?.stop(); capture = null
        if (socket) {
          try { socket.close() } catch { /* already closing */ }
          socket = null
        }
      }
      const finish = (): void => {
        if (closed) return
        closed = true
        teardown()
        onEnd?.()
      }

      try {
        socket = createSocket(buildStreamUrl(lang))
      } catch (err) {
        onError(err as Error)
        finish()
        return { stop: finish, abortTurn: finish }
      }
      socket.binaryType = 'arraybuffer'

      socket.onopen = () => {
        if (closed || !stream || !socket) return
        // Only now (socket ready) start pumping audio.
        capture = startCapture(stream, (pcm) => {
          if (!closed && socket) {
            try { socket.send(pcm) } catch { /* socket closing */ }
          }
        })
      }
      socket.onmessage = (ev) => {
        if (closed) return
        const msg = parseDeepgramMessage(ev.data)
        if (!msg || !msg.transcript) return
        if (msg.isFinal) onTurn(msg.transcript.trim())
        else onPartial?.(msg.transcript)
      }
      socket.onerror = () => {
        if (closed) return
        onError(new Error('voice stream socket error'))
        finish()
      }
      socket.onclose = () => finish()

      return {
        stop: () => finish(),
        abortTurn: () => {
          // Barge-in: drop the in-flight turn. With a per-utterance
          // socket that means ending this stream; the session reopens on
          // the next onset/press.
          logger.debug('[voice] ws stream abortTurn')
          finish()
        },
      }
    },
  }
}
