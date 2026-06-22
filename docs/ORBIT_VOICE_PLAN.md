# Orbit Voice Plan — Speech In, Speech Out

Design and phasing for giving **Orbit** (the AI digital docent)
a voice: speech-to-text (STT) so a visitor can *talk* to Orbit,
and text-to-speech (TTS) so Orbit can *talk back*. The existing
typed chat experience is untouched; voice is a feature-gated,
additive layer over the hybrid LLM + local-engine pipeline.

Status: **draft for review.** No code yet. This document scopes
the approach, the UI, the Cloudflare and client-side options, and
a phase plan that lands a usable web MVP first and defers the
expensive bits (realtime streaming, on-device models) behind it.

> Cross-references:
> [`docs/DOCENT_UX_IMPROVEMENT_PLAN.md`](DOCENT_UX_IMPROVEMENT_PLAN.md)
> (chat UX), [`docs/DOCENT_OPTIMIZATION_PLAN.md`](DOCENT_OPTIMIZATION_PLAN.md)
> (latency/token budgets), the Orbit character plans
> ([`ORBIT_CHARACTER_INTEGRATION_PLAN.md`](ORBIT_CHARACTER_INTEGRATION_PLAN.md)),
> and **§5 (voice docent)** of
> [`docs/VR_INVESTIGATION_PLAN.md`](VR_INVESTIGATION_PLAN.md) — the
> VR plan already reserves "voice docent" as a Phase 5 item; this
> plan is its 2D/web home and the VR surface consumes the same
> service layer.

---

## Goal

A visitor taps a mic button (or says a wake phrase, later),
speaks a question — *"show me sea surface temperature in the
Pacific"* — and Orbit transcribes it, runs it through the exact
same `processMessage()` pipeline that typed input uses (so dataset
loading, tool calls, and the local-engine fallback all still
work), then optionally **speaks** the answer aloud while the text
streams into the bubble. Hands-free, eyes-on-the-globe operation —
which is the whole point of a planetarium/kiosk/exhibit context,
and a strong accessibility win.

## Non-goals

- **Not** a full real-time conversational voice agent in v1 (no
  always-on listening, no barge-in interruption). That is Phase 3
  — now a **committed** phase (the exhibit requires hands-free; see
  §8 decision 5), but still sequenced *after* the turn-based
  push-to-talk MVP it builds on.
- **Not** voice for any surface other than Orbit. The catalog
  browse search, tour narration, and publisher portal are out of
  scope (tour *narration* via TTS is noted as a future stretch).
- **Not** a custom-trained wake-word or speaker-identification
  system. Wake-word, if pursued, uses an off-the-shelf small model.
- **Not** storing any audio. Captured audio is transcribed and
  discarded in-memory; nothing is persisted or logged (see
  §Privacy).

---

## 1. Where this plugs into the existing architecture

The hybrid Orbit pipeline (see `CLAUDE.md` → *Orbit — Digital
Docent*) is already well-shaped for this. Voice is **two
transducers bolted onto the ends of an unchanged core**:

```
  mic ──► [STT] ──► text ──► docentService.processMessage() ──► DocentStreamChunk* ──► chatUI bubble
                                                                          │
                                                            (delta text accumulates)
                                                                          ▼
                                                                   [TTS] ──► speaker
```

Concretely, the integration points (file/line references from the
current tree):

| Concern | Hook | Notes |
|---|---|---|
| Capture user speech | `src/ui/chatUI.ts` input area (`#chat-input`, send wiring ~`:413`) | New mic button writes the transcript into the same `handleSend()` path. The LLM/local engine never knows the input came from voice. |
| Config | `DocentConfig` in `src/types/index.ts`; defaults in `docentService.ts` `DEFAULT_CONFIG` (~`:225`); persisted under `sos-docent-config` | Add `voice*` fields to the existing blob — no new storage key. Sensitive provider keys (if any) follow the `apiKey` → OS-keychain pattern. |
| Speak the answer | `chatUI.ts` streaming receive loop (`handleSend()`, ~`:665`) consuming `DocentStreamChunk` `delta`s | TTS reads completed sentences as they stream (sentence-chunked), not the whole message at once — cuts perceived latency. |
| New backend (cloud path) | `functions/api/voice/transcribe.ts` + `…/synthesize.ts` | Mirror the `functions/api/chat/completions.ts` + `models.ts` shape: `onRequestPost`, the `AI` binding, the existing CORS helper. |
| Desktop CORS-free fetch | `corsFetch()` lazy-Tauri pattern in `llmProvider.ts` (~`:30`) | Reuse verbatim for audio upload/synthesis fetches. |
| Telemetry | `emit()` Tier B `orbit_*` events (`chatUI.ts` ~`:691`) | New `voice_interaction` event (Tier B), no transcript text stored. |

**Clean slate confirmed:** there is currently no
`SpeechRecognition`, `speechSynthesis`, `MediaRecorder`,
`getUserMedia`, or `AudioContext` usage anywhere in `src/`. No
conflicts to untangle.

A new service module `src/services/voiceService.ts` (mirroring
`llmProvider.ts`'s structure and lazy-import discipline) owns all
of this: capability detection, the STT/TTS provider abstraction,
and the audio plumbing. `chatUI.ts` only ever sees "give me a
transcript" and "speak this sentence."

---

## 2. Best practices (what "good" looks like)

These are the non-obvious things that separate a voice feature
that feels magical from one that feels broken:

1. **Push-to-talk before always-listening.** Start with an
   explicit mic tap (or press-and-hold). Always-on VAD (voice
   activity detection) is a privacy, battery, and false-trigger
   minefield — earn it in Phase 3, don't open with it.
2. **Show listening state unmistakably.** A pulsing mic / live
   audio-level meter while capturing, a distinct "thinking" state
   while the LLM streams, and a "speaking" state while TTS plays.
   Silence with no feedback reads as "broken."
3. **Stream partial transcripts** when the provider supports it
   (Web Speech `interimResults`, Deepgram WebSocket). Seeing words
   appear as you speak is the single biggest perceived-quality
   lever.
4. **Sentence-chunk the TTS.** Don't wait for the full LLM
   response. Speak sentence 1 while sentences 2–3 are still
   generating. Buffer on sentence boundaries (`. ! ?` + newline).
5. **Barge-in / interruptibility (Phase 3).** If the user starts
   talking while Orbit is speaking, duck/stop TTS immediately.
   Until then, at minimum give a visible **Stop speaking** control.
6. **Match the language to the active i18n locale.** The app is
   localized; STT/TTS language and voice selection should default
   to the current locale (`src/i18n/`), not hard-code `en-US`.
   Nova-3 and Aura-2 both have multi-language coverage; Web Speech
   honors a `lang` tag.
7. **Permissions are a first-class UX moment.** Request mic
   permission on first *intentional* tap, never on load. Handle
   denial gracefully (fall back to typing, explain why).
8. **Latency budget.** Turn-based target: transcript visible
   <1.5 s after speech ends; first spoken word of the answer
   <2 s after that. Edge STT/TTS (§3) is what makes this
   feasible. Track it via telemetry and the perf sampler.
9. **Degrade, never block.** No mic? No WebGPU? Provider down?
   Offline on localhost? Voice silently disables and typed chat is
   exactly as it was. This mirrors the existing local-engine
   fallback philosophy.
10. **Accessibility cuts both ways.** Voice output helps low-vision
    users; voice input helps motor-impaired users — but TTS must
    be *optional and interruptible*, captions (the streamed text)
    must always remain, and nothing should auto-play audio without
    consent (a deliberate toggle, remembered).

---

## 3. Does Cloudflare offer the services? — Yes, and it's a strong fit

Workers AI (the same `AI` binding already powering Orbit's chat in
`functions/api/chat/completions.ts`) now hosts first-party and
partner **speech** models. This means **no new vendor account, no
client-side API key, no new secret** — the audio terminates at the
same Cloudflare edge the app already deploys to, behind the same
`/api` proxy convention.

**Speech-to-text (STT):**

| Model | ID | Why / when |
|---|---|---|
| Whisper large v3 turbo | `@cf/openai/whisper-large-v3-turbo` | Out of beta, priced, accurate, simple **request/response** (POST audio → JSON transcript). Best **MVP cloud** choice — no WebSocket complexity. |
| Deepgram Nova-3 | `@cf/deepgram/nova-3` | Fast, high-accuracy, **10 languages** with regional variants, **WebSocket streaming** for live partial transcripts. The Phase 3 realtime choice. |
| Deepgram Flux | `@cf/deepgram/flux` | Conversational STT with **built-in turn detection** — the right primitive for barge-in / always-listening without rolling our own VAD. |

**Text-to-speech (TTS):**

| Model | ID | Why / when |
|---|---|---|
| Deepgram Aura-1 / Aura-2 | `@cf/deepgram/aura-1`, `@cf/deepgram/aura-2-en`, `…-es` | Context-aware, natural pacing/expressiveness, **WebSocket** capable. Best default quality. |
| MeloTTS (MyShell) | `@cf/myshell-ai/melotts` | Multilingual, **very cheap** (~$0.0002/audio-min). Good cost-optimized / high-volume kiosk default. |

**Realtime path (Phase 3+):** Workers AI added **WebSocket
support** to the Deepgram audio models (Nova-3, Flux, Aura), and
Cloudflare positions STT + LLM + TTS + turn-detection as a
**voice-agent stack** colocated at one edge data center
(advertised voice-to-voice round trips in the ~350–500 ms range,
TTFB <200 ms). Pairing with **Cloudflare Realtime** (WebRTC/SFU)
is the path to a true conversational agent — but that's well
beyond MVP and is called out as a deliberate later phase.

**Implication for us:** the cloud path is genuinely low-friction.
Two small Pages Functions (`transcribe`, `synthesize`) that wrap
the `AI` binding, modeled exactly on the existing
`chat/completions.ts`, cover Phases 2–3. The MVP (Phase 1) can
skip even that by using the browser's built-in speech APIs.

Sources:
[Aura-1](https://developers.cloudflare.com/workers-ai/models/aura-1/),
[Aura-2](https://developers.cloudflare.com/workers-ai/models/aura-2-en/),
[Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/),
[Whisper](https://developers.cloudflare.com/workers-ai/models/whisper/),
[MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/),
[Deepgram Flux changelog](https://developers.cloudflare.com/changelog/post/2025-10-02-deepgram-flux/),
[Partner-models blog](https://blog.cloudflare.com/workers-ai-partner-models/),
[Workers AI changelog](https://developers.cloudflare.com/workers-ai/changelog/).

---

## 4. Client-side computing & local models

There are three distinct "client-side" levers, with different
cost/quality/privacy profiles. We should use a **layered fallback**
that picks the best available at runtime — same spirit as the
hybrid LLM/local-engine design.

### 4.1 Browser-native Web Speech API — the free MVP

- **STT:** `SpeechRecognition` / `webkitSpeechRecognition`.
  Zero infra, supports interim results, free. **Caveat:** in
  Chrome it ships audio to Google's servers (so it's "client API,
  cloud backend" — a privacy nuance to disclose), Firefox support
  is weak, and it is **unreliable inside the Tauri/WKWebView
  desktop shell**. So: great for the web MVP, *not* a desktop
  answer.
- **TTS:** `speechSynthesis` + `SpeechSynthesisUtterance`. Fully
  on-device, free, voice quality varies by OS. Perfectly adequate
  as a default and as the universal fallback.

This is why **Phase 1 is web-only browser APIs**: it ships a real
feature with zero backend work and zero cost, and validates the UX
before we spend on edge inference.

### 4.2 On-device neural models (WebGPU) — privacy/offline path

`transformers.js` can run **Whisper tiny/base** in-browser via
WebGPU for fully-local, offline-capable STT (no audio leaves the
device — a genuine privacy story, and works on the desktop app and
on localhost where the `/api` proxy is absent). Kokoro / Piper-class
TTS can likewise run client-side. Tradeoffs: model download weight
(tens to ~150 MB), WebGPU availability (`src/utils/deviceCapability.ts`
+ existing VR WebGPU detection give us the gating), and lower
accuracy than Nova-3/Aura. **Lazy-loaded exactly like the Three.js
VR chunk** — non-voice users never pay for it. This is a Phase 4
opt-in ("on-device / private mode"), not a default.

### 4.3 Apple platform speech (macOS desktop)

We already have a precedent for OS-native AI on Apple:
`src/services/appleIntelligenceProvider.ts` uses Foundation Models
for on-device LLM. The Apple **Speech framework** (STT) and
**AVSpeechSynthesizer** (TTS) are the natural on-device voice
equivalents for the Tauri macOS build, reachable via a small Rust
command in `src-tauri/`. High quality, fully local, no cost. Phase
4, alongside 4.2, behind the same `voiceProvider: 'auto'` resolver.

### 4.4 Provider-selection resolver

`voiceService.ts` exposes a single `resolveProviders()` that picks,
at runtime:

```
STT:  on-device (if enabled & capable) → Cloudflare edge (web/desktop) → Web Speech (web) → none
TTS:  OS-native (Apple/desktop) → Cloudflare edge → speechSynthesis → none
```

Config surfaces this as `voiceProvider: 'auto' | 'cloud' | 'local' | 'browser'`
so power users / kiosk operators can pin a path. Default `'auto'`.

---

## 5. New UI

The guiding principle: **voice is an affordance on the existing
chat surface, not a new surface.** Nothing moves; we add controls.

### 5.1 In the chat input row (`chatUI.ts`)

- **Mic button** next to send (`#chat-mic`). States: idle → press
  to talk; **listening** (pulsing + live input-level meter, partial
  transcript filling `#chat-input` as you speak); **transcribing**;
  back to idle. Long-press = hold-to-talk; tap = toggle. On a final
  transcript it auto-sends (configurable).
- **Live caption / interim transcript** rendered into the existing
  textarea so the user sees what's being heard and can edit before
  send.
- **Permission + error inline state**: denied-mic and
  unsupported-browser show a one-line explainer, never a dead
  button.

### 5.2 On Orbit's reply

- **Speaker toggle** on each assistant bubble (and a global "auto-
  speak replies" setting). While speaking: a **Stop speaking**
  control and a subtle per-word/sentence highlight tracking the
  audio.
- The streamed **text stays the canonical output** (captions are
  never replaced by audio) — accessibility + i18n requirement.

### 5.3 Settings panel additions (`#chat-settings`)

Mirror the existing `visionEnabled` toggle pattern (~`chatUI.ts:432`):

- `Voice input` on/off, `Auto-speak replies` on/off
- `Voice` picker (enumerate `speechSynthesis.getVoices()` and/or
  Aura/MeloTTS voices), `Speaking rate`
- `Voice provider`: Auto / Cloud (Cloudflare) / On-device / Browser
- `Recognition language`: defaults to active i18n locale, override
  available
- Push-to-talk vs tap-to-toggle; auto-send-on-final on/off

### 5.4 Orbit character & VR tie-ins (later phases)

- The **Orbit character** (`src/services/orbitCharacter/`) has a
  gesture/state vocabulary — a **"speaking" animation / pseudo-
  lip-sync** driven by TTS audio amplitude is a high-delight,
  low-risk add once audio playback exists (Phase 5).
- The **VR docent** (`VR_INVESTIGATION_PLAN.md` §5) consumes the
  same `voiceService` — voice is *more* compelling in immersive
  mode (hands occupied, no keyboard). Spatial audio for Orbit's
  voice is a VR-specific stretch.

### 5.5 i18n & a11y

Every new label/ARIA string goes through `t()` (the
`check:i18n-strings` gate covers `src/ui/`). Mic/speaker buttons
need proper `aria-label`s and `aria-pressed`/`aria-live` regions
for the listening/speaking state. New scenes for
`scripts/screenshots/scenes.ts` (mic idle/listening, settings with
voice rows) per the visual-testing convention.

---

## 6. Privacy & analytics

Voice is sensitive; this slots into the existing privacy-first
analytics model (`docs/ANALYTICS.md`, `docs/PRIVACY.md`).

- **No audio persisted, ever.** Captured audio is streamed/posted
  for transcription and dropped. Transcripts live only in the
  in-memory chat history already used for typed chat.
- **New Tier B event `voice_interaction`** (research-tier, opt-in
  — add to `TIER_B_EVENT_TYPES` in `src/types/index.ts`):
  `{ mode: 'stt' | 'tts', provider: 'cloud'|'local'|'browser',
  duration_ms, lang, success }`. **No transcript text, no hashes
  of speech.** Follow the `docs/ANALYTICS_CONTRIBUTING.md`
  checklist + add a test.
- **Disclosure:** the first mic activation shows a one-time
  explainer of where audio goes for the selected provider (esp.
  the Web Speech "Chrome→Google" nuance and the Cloudflare-edge
  path). On-device mode advertises "audio never leaves this
  device."
- **Privacy-policy update** (`docs/PRIVACY.md` →
  `public/privacy.html` via `npm run build:privacy-page`, guarded
  by `check:privacy-page`) describing the voice data flow per
  provider.

---

## 7. Phase plan

Each phase is independently shippable and adds no regression risk
to typed chat. Ordering front-loads value; ordering reflects the
§8 decisions (auto-speak off, browser-API MVP, MeloTTS default,
cost guards with Phase 2, and **hands-free as a committed
requirement** that pulls realtime ahead of on-device).

| Phase | Scope | Surface | Backend | Cost |
|---|---|---|---|---|
| **0 — Spike** | `voiceService.ts` skeleton + capability detection; throwaway prototype wiring Web Speech STT into `handleSend()` and `speechSynthesis` onto a reply. Validate UX, latency, the sentence-chunking. | branch only | none | none |
| **1 — Web MVP** | Mic button + listening UI + interim transcript; auto-speak toggle (**default off**); settings rows; i18n + a11y + scenes + Tier B telemetry. **Browser APIs only.** | web | none | none |
| **2 — Cloud STT/TTS + guards** | `functions/api/voice/{transcribe,synthesize}.ts` over the `AI` binding (Whisper turbo STT; **MeloTTS default**, Aura-2 opt-in); `voiceProvider` resolver; desktop via `corsFetch`. **`KILL_VOICE` env + per-session usage caps + client cooldown land here.** | web + desktop | 2 Pages Functions | edge inference |
| **3 — Realtime / hands-free** *(committed — exhibit req.)* | Deepgram **Flux** turn detection + **Nova-3/Flux WebSocket** streaming partials; always-listening with **local VAD gating before any audio is streamed**, clear listening indicator + mute; **barge-in**; "Stop speaking" → "interrupt" upgrade. | web + desktop | WS proxy / Realtime | edge inference |
| **3.5 — Wake-word** *(committed)* | "Hey Orbit" off-the-shelf small wake model to arm listening hands-free in the exhibit. | web + desktop | local / WS | edge inference |
| **4 — On-device / private** | WebGPU Whisper + local TTS (`transformers.js`); Apple Speech/AVSpeechSynthesizer on macOS Tauri; "private mode." | web (WebGPU) + desktop | none (local) | none |
| **5 — Character & VR** | Orbit-character speaking animation / amplitude lip-sync; wire `voiceService` into the VR docent (`VR_INVESTIGATION_PLAN.md` §5); optional spatial audio. | web + VR | reuse | reuse |

**Stretch / explicitly deferred:** tour **narration** via TTS,
voice-driven catalog search (noted as a Phase 3 stretch in the VR
plan), speaker diarization for multi-visitor kiosks. *(Wake-word
moved into the committed roadmap as Phase 3.5 per §8 decision 5.)*

---

## 8. Resolved decisions

These five were locked in review (2026-06-22). They supersede the
recommendations elsewhere in this doc where they differ.

1. **Auto-speak is OFF by default.** Voice output is opt-in via a
   toggle, with a prominent first-run nudge. Captions (the streamed
   text) always remain regardless. Rationale: shared/quiet exhibit
   spaces; no surprise audio. (§5.2)
2. **Phase 1 ships browser APIs only** (Web Speech STT +
   `speechSynthesis` TTS). Web-only, zero cost, fast to validate
   UX — accepting the known cross-browser inconsistency and desktop
   gap, which the Phase 2 Cloudflare path then closes. (§7)
3. **Cloud TTS default is MeloTTS**, with Deepgram **Aura-2 as an
   opt-in "higher-quality voice."** Rationale: MeloTTS is ~10×
   cheaper — the right default for high-volume kiosk use. (§3, §7)
4. **Cost guardrails are in scope.** Add a server **`KILL_VOICE`**
   env (modeled on `KILL_TELEMETRY` → 410 + client cooldown) plus
   **per-session usage caps**. These land **with Phase 2** (the
   first phase that incurs edge inference cost), not later. (§6, §9)
5. **Hands-free is a committed exhibit requirement** — *not* a
   deferred stretch. The NOAA SOS install needs always-listening
   operation. This **promotes the realtime work (Phase 3) and a
   wake-word into the committed roadmap** and reorders priority:
   Phase 3 now lands **before** the on-device/private work (former
   Phase 4), since the exhibit value depends on it. Deepgram
   **Flux** (built-in turn detection) is the primitive; wake-word
   ("Hey Orbit") becomes **Phase 3.5** rather than a stretch item.
   Privacy handling for an always-on mic (local VAD gating before
   any audio is streamed, clear "listening" indicator, mute
   control, disclosure) is elevated to a Phase 3 acceptance
   criterion. (§7, §6)

> **Phasing impact of #5:** the table in §7 is renumbered so the
> realtime/hands-free phase precedes on-device. Phases 1–2 are
> unchanged building blocks (push-to-talk MVP, then the cloud
> proxy + `voiceProvider` resolver that Phase 3 streams over).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Web Speech API inconsistency / desktop gaps | Phase 1 is explicitly "best-effort web"; Phase 2 cloud path is the consistency backstop; resolver degrades silently. |
| Edge inference latency/cost at exhibit scale | MeloTTS cheap default; sentence-chunked TTS hides latency; `KILL_VOICE` + per-session caps; on-device Phase 4 removes per-use cost. |
| Mic permission friction / denial | Request only on intentional tap; graceful typed-chat fallback; clear inline explainer. |
| Privacy perception (audio leaving device) | Per-provider disclosure; on-device "private mode"; no audio stored; Tier B opt-in telemetry with no transcript content. |
| Bundle bloat | All voice code lazy-loaded behind capability + config gates (Three.js-chunk precedent); WebGPU models only fetched in on-device mode. |
| i18n/RTL/a11y regressions | All strings via `t()`; logical CSS properties; new screenshot scenes + smoke assertion per the repo conventions. |
| Scope creep into a full voice agent | Hard phase boundaries; realtime/barge-in gated behind a proven turn-based MVP; non-goals enumerated above. |

---

## 10. First implementation slice (when approved)

To keep changes "one logical change per turn" (per `CLAUDE.md`):

1. Add `voiceService.ts` skeleton + capability detection + the
   provider resolver (no UI yet). Module-map row in `CLAUDE.md`
   in the same commit (doc-coverage gate).
2. Extend `DocentConfig` with `voice*` fields + defaults.
3. Mic button + listening UI + interim transcript (Web Speech STT)
   → `handleSend()`. New scene + i18n keys.
4. `speechSynthesis` auto-speak with sentence-chunking + Stop
   control + settings toggle.
5. Tier B `voice_interaction` event + test + `ANALYTICS.md` row.

Each is a self-contained, signed-off (`git commit -s`) commit.
