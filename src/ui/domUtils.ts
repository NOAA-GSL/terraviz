// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Small DOM helpers shared across UI modules.
 *
 * Lives in its own file so modules can import escape helpers without
 * pulling in the full browseUI module — keeps the UI modules free of
 * circular dependencies.
 */

/** Escape HTML special characters to prevent XSS in rendered content. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escape a string for safe use inside an HTML attribute value. */
export function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Push a polite announcement to the app-wide ARIA live region
 * (`#a11y-announcer`, in `src/index.html`).
 *
 * Shared rather than copied because the clear-then-set-next-frame
 * dance is the part that is easy to leave out and impossible to
 * notice: a live region whose text is assigned the value it already
 * holds is not a change, so the second identical announcement is
 * silently dropped — which is exactly the shape of an announcement
 * worth making twice ("link stale", again, about a different output).
 *
 * Absence of the region is not an error. `src/orbit.html` carries one
 * and so does the SPA, but a module mounted into some other document
 * should cost its caller nothing.
 */
export function announcePolite(message: string): void {
  const live = document.getElementById('a11y-announcer')
  if (!live) return
  live.textContent = ''
  requestAnimationFrame(() => {
    live.textContent = message
  })
}
