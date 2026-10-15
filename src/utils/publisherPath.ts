// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Is this path the publisher portal?
 *
 * One predicate, because three things must agree on the answer and
 * a disagreement is a security hole rather than a cosmetic bug:
 *
 * - `src/main.ts` boots the portal instead of the globe when it is
 *   true;
 * - `public/_headers` sends `frame-ancestors 'self'` on `/publish` and
 *   `/publish/*`, which is what stops another site framing the portal;
 * - `scripts/pages-headers.test.ts` holds the two together, asserting
 *   that every path this accepts is a path those rules protect.
 *
 * The gate used to be `startsWith('/publish')`, which also booted the
 * portal on `/publisher`, `/publishing` or `/publish-x`. None of those
 * matched the header rules, so each was a frameable copy of the admin
 * surface: the portal's sidebar navigates with `pushState`, so a page
 * loaded at `/publisher` could reach every portal page without the
 * browser ever fetching a protected URL.
 *
 * Imports nothing, so server code can share it without pulling the
 * SPA in.
 */
export function isPublisherPortalPath(pathname: string): boolean {
  return pathname === '/publish' || pathname.startsWith('/publish/')
}
