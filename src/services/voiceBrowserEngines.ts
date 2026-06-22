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
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    synth.speak(utterance)
  }),
  cancel: () => {
    try {
      (window as unknown as Record<string, any>)['speechSynthesis']?.cancel()
    } catch { /* nothing speaking */ }
  },
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
