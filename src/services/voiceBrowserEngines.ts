/**
 * Browser Web Speech engines — the Phase 1 STT/TTS implementations
 * that register against `voiceService`'s resolver.
 *
 * STT uses `SpeechRecognition` / `webkitSpeechRecognition`; TTS uses
 * `speechSynthesis` + `SpeechSynthesisUtterance`. Both are
 * best-effort for any language the host OS/browser happens to
 * support — so they declare broad language coverage and sit *last*
 * in the `auto` resolver order, after the curated cloud/on-device
 * engines (docs/ORBIT_VOICE_PLAN.md §4.1, §4.4).
 *
 * Privacy note: in Chrome, `SpeechRecognition` ships audio to
 * Google. Acceptable for the open-web MVP; the public-kiosk path
 * must use the cloud/on-device engines instead (voice plan §6.1).
 */

import {
  registerSttEngine,
  registerTtsEngine,
  detectVoiceCapabilities,
  type SttEngine,
  type TtsEngine,
  type VoiceCapabilities,
} from './voiceService'
import { logger } from '../utils/logger'

// --- Minimal Web Speech typings (not in this project's TS lib set) ---

interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  readonly length: number
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionResultListLike {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition'] ?? null) as SpeechRecognitionCtor | null
}

/** STT via the Web Speech API. */
export const browserSttEngine: SttEngine = {
  provider: 'browser',
  // Best-effort: the browser attempts whatever BCP-47 tag we give it.
  supportsLanguage: (lang) => !!lang,
  isAvailable: (caps) => caps.webSpeechStt,
  start: ({ lang, interim, onResult, onError, onEnd }) => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      onError(new Error('SpeechRecognition unavailable'))
      onEnd()
      return { stop: () => {} }
    }
    const rec = new Ctor()
    rec.lang = lang
    rec.interimResults = interim
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        onResult({ transcript: result[0]?.transcript ?? '', isFinal: result.isFinal })
      }
    }
    rec.onerror = (event) => onError(new Error(event?.error || 'speech-recognition-error'))
    rec.onend = () => onEnd()
    try {
      rec.start()
    } catch (err) {
      onError(err as Error)
      onEnd()
    }
    return {
      stop: () => {
        try { rec.stop() } catch { /* already stopped */ }
      },
    }
  },
}

/** TTS via `speechSynthesis`. */
/**
 * Live utterances. Chrome garbage-collects a `SpeechSynthesisUtterance`
 * that isn't referenced from JS while it's mid-flight — the result is
 * no audio AND `onend` never firing (so a caller awaiting the speak
 * would hang and a Stop control would stick). Holding a reference here
 * until the utterance settles avoids that. (ORBIT_VOICE_PLAN §10.2)
 */
const liveUtterances = new Set<unknown>()

export const browserTtsEngine: TtsEngine = {
  provider: 'browser',
  supportsLanguage: (lang) => !!lang,
  isAvailable: (caps) => caps.speechSynthesis,
  speak: (text, opts) => new Promise<void>((resolve) => {
    const w = window as unknown as Record<string, any>
    const synth = w['speechSynthesis']
    const Utterance = w['SpeechSynthesisUtterance']
    if (!synth || !Utterance || !text) {
      resolve()
      return
    }
    const utterance = new Utterance(text)
    utterance.lang = opts.lang
    if (typeof opts.rate === 'number') utterance.rate = opts.rate
    if (opts.voice) {
      const match = synth.getVoices?.().find((v: { name: string }) => v.name === opts.voice)
      if (match) utterance.voice = match
    }
    liveUtterances.add(utterance)
    let settled = false
    // Safety net: if the engine never reports completion (some
    // browsers drop onend after a cancel, or stall), resolve anyway
    // so the speech queue can't wedge and the Stop control can't stick.
    const timeoutMs = Math.min(60000, 4000 + text.length * 120)
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      liveUtterances.delete(utterance)
      resolve()
    }
    utterance.onend = finish
    utterance.onerror = finish
    timer = setTimeout(finish, timeoutMs)
    try {
      synth.speak(utterance)
      // Chrome can leave synthesis paused after a prior cancel(); nudge it.
      synth.resume?.()
    } catch (err) {
      logger.warn('[voice] speechSynthesis.speak failed', err)
      finish()
    }
  }),
  cancel: () => {
    liveUtterances.clear()
    try {
      (window as unknown as Record<string, any>)['speechSynthesis']?.cancel()
    } catch { /* nothing speaking */ }
  },
}

let ttsPrimed = false

/**
 * Unlock `speechSynthesis` for iOS Safari, which only produces audio
 * if synthesis was first invoked from inside a user gesture. Auto-speak
 * fires later from an async chain, so we prime it once from an early tap
 * (mic / send / enabling auto-speak) by speaking a silent blank
 * utterance. Idempotent and inaudible. (ORBIT_VOICE_PLAN §10.5)
 */
export function primeBrowserTts(): void {
  if (ttsPrimed) return
  const w = window as unknown as Record<string, any>
  const synth = w['speechSynthesis']
  const Utterance = w['SpeechSynthesisUtterance']
  if (!synth || !Utterance) return
  try {
    const u = new Utterance(' ')
    u.volume = 0
    synth.speak(u)
    synth.resume?.()
    ttsPrimed = true
  } catch { /* priming is best-effort */ }
}

/**
 * Register the browser engines that the current runtime can support.
 * Idempotent (the registry de-dupes by provider). Safe to call from
 * UI init; returns the capabilities it acted on.
 */
export function registerBrowserVoiceEngines(
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): VoiceCapabilities {
  if (caps.webSpeechStt) registerSttEngine(browserSttEngine)
  if (caps.speechSynthesis) registerTtsEngine(browserTtsEngine)
  logger.debug('[voice] browser engines registered', { stt: caps.webSpeechStt, tts: caps.speechSynthesis })
  return caps
}
