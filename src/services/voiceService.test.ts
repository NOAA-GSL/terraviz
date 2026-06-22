import { describe, it, expect, beforeEach } from 'vitest'
import {
  baseLanguage,
  toSpokenForm,
  splitIntoSpokenChunks,
  detectVoiceCapabilities,
  resetVoiceEngines,
  registerSttEngine,
  registerTtsEngine,
  resolveSttEngine,
  resolveTtsEngine,
  voiceSupportForLocale,
  createFakeSttEngine,
  createFakeTtsEngine,
  CLOUD_STT_LANGUAGES,
  CLOUD_TTS_LANGUAGES,
  type VoiceCapabilities,
} from './voiceService'

const ALL_CAPS: VoiceCapabilities = {
  webSpeechStt: true,
  speechSynthesis: true,
  mediaRecorder: true,
  getUserMedia: true,
}

beforeEach(() => {
  resetVoiceEngines()
})

describe('baseLanguage', () => {
  it('reduces a BCP-47 tag to its base subtag, lowercased', () => {
    expect(baseLanguage('pt-BR')).toBe('pt')
    expect(baseLanguage('EN')).toBe('en')
    expect(baseLanguage('es')).toBe('es')
    expect(baseLanguage('')).toBe('')
  })
})

describe('toSpokenForm', () => {
  it('strips load markers, dataset ids, and placeholders', () => {
    const out = toSpokenForm('Try this <<LOAD:INTERNAL_SOS_42>> dataset [[LOAD:DS01ARZ3NDEKTSV4RRFFQ69G5FAV]] now')
    expect(out).not.toMatch(/LOAD/)
    expect(out).not.toMatch(/INTERNAL_/)
    expect(out).not.toMatch(/DS01ARZ/)
    expect(out).toContain('Try this')
    expect(out).toContain('dataset')
  })

  it('flattens markdown emphasis, headings, lists, and code', () => {
    const md = '# Title\n\n- **bold** item\n- `code` item\n\nSome _italic_ text.'
    const out = toSpokenForm(md)
    expect(out).not.toMatch(/[#*_`]/)
    expect(out).toContain('bold item')
    expect(out).toContain('code item')
    expect(out).toContain('italic text')
  })

  it('reduces links to their text and removes bare URLs', () => {
    expect(toSpokenForm('See [the catalog](https://example.com/x) here')).toBe('See the catalog here')
    expect(toSpokenForm('Visit https://example.com/page for more').trim()).toBe('Visit for more')
  })

  it('expands the spoken glossary as whole words only', () => {
    expect(toSpokenForm('SST is rising')).toBe('sea surface temperature is rising')
    // Should not expand inside another token.
    expect(toSpokenForm('SSTABLE')).toBe('SSTABLE')
  })
})

describe('splitIntoSpokenChunks', () => {
  it('splits on sentence boundaries and drops empties', () => {
    const chunks = splitIntoSpokenChunks('Hello there. How are you?\n\nLoading now!')
    expect(chunks).toEqual(['Hello there.', 'How are you?', 'Loading now!'])
  })

  it('returns an empty array for marker-only / blank input', () => {
    expect(splitIntoSpokenChunks('<<LOAD:INTERNAL_SOS_1>>')).toEqual([])
    expect(splitIntoSpokenChunks('   ')).toEqual([])
  })
})

describe('detectVoiceCapabilities', () => {
  it('is safe to call and returns booleans', () => {
    const caps = detectVoiceCapabilities()
    expect(typeof caps.webSpeechStt).toBe('boolean')
    expect(typeof caps.speechSynthesis).toBe('boolean')
    expect(typeof caps.mediaRecorder).toBe('boolean')
    expect(typeof caps.getUserMedia).toBe('boolean')
  })
})

describe('resolver + capability matrix', () => {
  it('returns null when no engines are registered (safe degrade)', () => {
    expect(resolveSttEngine('auto', 'en', ALL_CAPS)).toBeNull()
    expect(voiceSupportForLocale('en', 'auto', ALL_CAPS)).toEqual({ stt: null, tts: null })
  })

  it('resolves a registered engine that supports the language', () => {
    registerSttEngine(createFakeSttEngine({ provider: 'browser', languages: ['en', 'es'] }))
    expect(resolveSttEngine('auto', 'es', ALL_CAPS)?.provider).toBe('browser')
    expect(resolveSttEngine('auto', 'pt', ALL_CAPS)).toBeNull() // unsupported language
  })

  it('honours auto order: local before cloud before browser', () => {
    registerTtsEngine(createFakeTtsEngine({ provider: 'browser', languages: ['en'] }))
    registerTtsEngine(createFakeTtsEngine({ provider: 'cloud', languages: ['en'] }))
    registerTtsEngine(createFakeTtsEngine({ provider: 'local', languages: ['en'] }))
    expect(resolveTtsEngine('auto', 'en', ALL_CAPS)?.provider).toBe('local')
  })

  it('a pinned preference selects only that provider', () => {
    registerTtsEngine(createFakeTtsEngine({ provider: 'browser', languages: ['en'] }))
    expect(resolveTtsEngine('cloud', 'en', ALL_CAPS)).toBeNull()
    expect(resolveTtsEngine('browser', 'en', ALL_CAPS)?.provider).toBe('browser')
  })

  it('skips engines that are unavailable for the runtime', () => {
    registerSttEngine(createFakeSttEngine({ provider: 'browser', languages: ['en'], available: false }))
    expect(resolveSttEngine('auto', 'en', ALL_CAPS)).toBeNull()
  })

  it('reports per-locale support for STT and TTS independently', () => {
    registerSttEngine(createFakeSttEngine({ provider: 'cloud', languages: CLOUD_STT_LANGUAGES }))
    registerTtsEngine(createFakeTtsEngine({ provider: 'cloud', languages: CLOUD_TTS_LANGUAGES }))
    // Hindi: Nova-3 STT yes, cloud TTS no.
    expect(voiceSupportForLocale('hi', 'auto', ALL_CAPS)).toEqual({ stt: 'cloud', tts: null })
    // Korean: cloud TTS yes, STT no.
    expect(voiceSupportForLocale('ko', 'auto', ALL_CAPS)).toEqual({ stt: null, tts: 'cloud' })
    // Kabyle: neither.
    expect(voiceSupportForLocale('kab', 'auto', ALL_CAPS)).toEqual({ stt: null, tts: null })
  })
})

describe('fake engines', () => {
  it('the fake STT engine emits its scripted transcript as final', async () => {
    const engine = createFakeSttEngine({ transcript: 'show me sea ice' })
    const results: string[] = []
    await new Promise<void>((resolve) => {
      engine.start({
        lang: 'en',
        interim: false,
        onResult: (r) => { if (r.isFinal) results.push(r.transcript) },
        onError: () => {},
        onEnd: () => resolve(),
      })
    })
    expect(results).toEqual(['show me sea ice'])
  })

  it('the fake TTS engine records spoken text into the provided sink', async () => {
    const spoken: string[] = []
    const engine = createFakeTtsEngine({ spoken })
    await engine.speak('hello', { lang: 'en' })
    expect(spoken).toEqual(['hello'])
  })
})
