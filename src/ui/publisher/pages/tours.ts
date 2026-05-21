/**
 * `/publish/tours` — landing page for the tour-creator sub-phase
 * set. Phase 3pt/A ships an empty-state card plus a "New tour"
 * button that bounces the user into the SPA's tour-authoring
 * mode (`/?tourEdit=new`). The list of existing tours and per-
 * row Edit / Preview links land in tour/E (alongside autosave
 * and backend persistence — without those, the list would be
 * empty by construction).
 *
 * Visual conventions match `pages/datasets.ts`: `publisher-shell`
 * outer, `publisher-card publisher-glass` for the empty state,
 * `publisher-tab`-style buttons for primary actions.
 */

import { t } from '../../../i18n'

export interface ToursPageOptions {
  /** Host-supplied navigator. Tests stub this. Defaults to
   *  `window.location.assign` so the SPA-mode entry actually
   *  leaves the publisher portal. */
  navigate?: (url: string) => void
}

export function renderToursPage(content: HTMLElement, options: ToursPageOptions = {}): void {
  const navigate = options.navigate ?? ((url: string) => {
    window.location.assign(url)
  })

  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const header = document.createElement('div')
  header.className = 'publisher-tour-list-header'

  const h2 = document.createElement('h2')
  h2.textContent = t('publisher.tours.heading')
  header.appendChild(h2)

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-tab publisher-tab-active publisher-tour-new-btn'
  newBtn.setAttribute('aria-label', t('publisher.tours.new.aria'))
  newBtn.textContent = t('publisher.tours.new')
  newBtn.addEventListener('click', () => {
    // `?tourEdit=new` is the sentinel the SPA-side dock checks.
    // No backend round-trip in tour/A — autosave + the
    // create-row path land in tour/E.
    navigate('/?tourEdit=new')
  })
  header.appendChild(newBtn)
  shell.appendChild(header)

  const intro = document.createElement('p')
  intro.className = 'publisher-tour-intro'
  intro.textContent = t('publisher.tours.intro')
  shell.appendChild(intro)

  const empty = document.createElement('section')
  empty.className = 'publisher-card publisher-glass publisher-empty'
  const emptyTitle = document.createElement('p')
  emptyTitle.className = 'publisher-empty-message'
  emptyTitle.textContent = t('publisher.tours.empty.title')
  empty.appendChild(emptyTitle)
  const emptyHint = document.createElement('p')
  emptyHint.className = 'publisher-tour-empty-hint'
  emptyHint.textContent = t('publisher.tours.empty.hint')
  empty.appendChild(emptyHint)
  shell.appendChild(empty)

  content.replaceChildren(shell)
}
