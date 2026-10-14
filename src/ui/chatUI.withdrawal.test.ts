// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A page losing Orbit mid-session: the node's operator turned it off
 * after this page booted, and a re-read or a refused request reported
 * it (`orbitAvailability`). The property that matters is not the
 * panel closing but everything that could still be listening or
 * talking stopping with it — so the voice resolver is mocked here, in
 * a file of its own, to hand the chat an engine whose `stop` can be
 * watched without leaking a registered engine into other suites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const engineStop = vi.fn()

vi.mock('../services/voiceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/voiceService')>()
  return {
    ...actual,
    resolveSttEngine: () => ({
      provider: 'browser',
      supportsLanguage: () => true,
      isAvailable: () => true,
      start: () => ({ stop: engineStop, abort: engineStop }),
    }),
  }
})

const { initChatUI, openChat, setOrbitAvailable, ORBIT_CHROME_SELECTOR } = await import('./chatUI')
const { HandsFreeController } = await import('./voiceHandsFree')
const { withdrawOrbit, resetOrbitAvailabilityForTests } = await import('../services/orbitAvailability')

function setupDOM(): void {
  document.body.innerHTML = `
    <button id="tools-menu-toggle"></button>
    <div id="tools-menu-popover" class="hidden">
      <button id="tools-menu-close"></button>
      <section class="tools-menu-section-orbit"><button id="tools-menu-orbit-settings"></button></section>
    </div>
    <button id="chat-trigger"></button>
    <div id="chat-dataset-prompt" class="hidden"></div>
    <div id="chat-panel" class="hidden">
      <button id="chat-close"></button>
      <div id="chat-settings" class="hidden"></div>
      <div id="chat-messages"></div>
      <textarea id="chat-input"></textarea>
      <button id="chat-mic"></button>
      <button id="chat-send"></button>
    </div>
  `
}

const announce = vi.fn()

function startChat(): void {
  initChatUI({
    onLoadDataset: vi.fn(),
    getDatasets: () => [],
    getCurrentDataset: () => null,
    announce,
  } as unknown as Parameters<typeof initChatUI>[0])
}

beforeEach(() => {
  setupDOM()
  sessionStorage.clear()
  localStorage.clear()
  resetOrbitAvailabilityForTests()
  engineStop.mockClear()
  announce.mockClear()
})

afterEach(() => {
  setOrbitAvailable(true)
  vi.restoreAllMocks()
})

describe('Orbit withdrawn mid-session', () => {
  it('closes the panel and tells a screen-reader user why', () => {
    startChat()
    openChat()
    withdrawOrbit('recheck')
    expect(document.getElementById('chat-panel')!.classList.contains('hidden')).toBe(true)
    expect(document.body.classList.contains('orbit-disabled')).toBe(true)
    expect(announce).toHaveBeenLastCalledWith('Orbit has been turned off on this site')
  })

  it('stops a capture in progress, and the hands-free session', () => {
    const teardown = vi.spyOn(HandsFreeController.prototype, 'teardown')
    startChat()
    openChat()
    document.getElementById('chat-mic')!.click()
    expect(engineStop).not.toHaveBeenCalled()
    withdrawOrbit('voice')
    expect(engineStop).toHaveBeenCalled()
    expect(teardown).toHaveBeenCalled()
  })

  it('refuses a new capture afterwards', () => {
    startChat()
    withdrawOrbit('chat')
    document.getElementById('chat-mic')!.click()
    expect(engineStop).not.toHaveBeenCalled()
    expect(document.getElementById('chat-mic')!.getAttribute('aria-pressed')).not.toBe('true')
  })

})

describe('focus when Orbit is withdrawn', () => {
  it('moves from the chat to the open Tools menu', () => {
    startChat()
    openChat()
    document.getElementById('tools-menu-popover')!.classList.remove('hidden')
    document.getElementById('chat-input')!.focus()
    withdrawOrbit('recheck')
    expect(document.activeElement?.id).toBe('tools-menu-close')
  })

  it('moves from the Tools-menu Orbit section to the Tools toggle when the menu is closed', () => {
    document.getElementById('tools-menu-orbit-settings')!.focus()
    setOrbitAvailable(false)
    expect(document.activeElement?.id).toBe('tools-menu-toggle')
  })

  it('catches a visitor whose focus a reply in progress dropped to the body', () => {
    // The input is disabled while a reply streams, and a refused reply
    // is how most pages learn Orbit was withdrawn.
    startChat()
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.focus()
    // A browser drops focus when the input is disabled; happy-dom only
    // on blur, so blur first to reach the same state.
    input.blur()
    input.disabled = true
    expect(document.activeElement).toBe(document.body)
    withdrawOrbit('chat')
    expect(document.activeElement?.id).toBe('tools-menu-toggle')
  })

  it('leaves focus alone when it is not on Orbit', () => {
    document.getElementById('tools-menu-toggle')!.focus()
    setOrbitAvailable(false)
    expect(document.activeElement?.id).toBe('tools-menu-toggle')
  })
})

describe('ORBIT_CHROME_SELECTOR', () => {
  it('names exactly what `body.orbit-disabled` hides in chat.css', () => {
    // Focus is rescued from this list and the stylesheet hides its own;
    // an element in one and not the other is focus lost to a hidden
    // control, or Orbit chrome left showing.
    const chatCss = readFileSync(resolve(process.cwd(), 'src/styles/chat.css'), 'utf-8')
    const rule = /((?:body\.orbit-disabled [^,{]+,\s*)*body\.orbit-disabled [^,{]+)\{/.exec(chatCss)
    expect(rule).toBeTruthy()
    const hidden = rule![1]
      .split(',')
      .map(part => part.trim().replace(/^body\.orbit-disabled\s+/, ''))
      .sort()
    const named = ORBIT_CHROME_SELECTOR.split(',').map(part => part.trim()).sort()
    expect(named).toEqual(hidden)
  })
})
