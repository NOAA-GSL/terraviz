// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Can this browser render the globe at all?
 *
 * Split out of `main.ts`'s `checkWebGLSupport()` so the question has an
 * answer a test can reach: `main.ts` exports nothing and boots on import,
 * so the predicate was previously only reachable by driving the whole
 * `DOMContentLoaded` path — which is why the test named for it
 * re-implemented the expression locally and asserted against its own copy
 * rather than the shipped one. A copy of a predicate passes whatever the
 * original does.
 *
 * **WebGL 2 specifically, and there is deliberately no WebGL 1 fallback.**
 * MapLibre 6 dropped WebGL 1 outright — its `canvasContextAttributes`
 * types `contextType` as the literal `'webgl2'` and nothing else — and the
 * value readout (`glLumaSampler`) has always needed 2. Accepting a
 * WebGL-1-only context would clear this preflight and then fail inside the
 * renderer, which costs the user the troubleshooting screen `main.ts`
 * draws on a `false` return: the one place the app explains what to do.
 * A blank globe and no explanation is the worse of the two failures.
 *
 * The canvas comes in through a factory so a test can supply one without a
 * document, and so a stubbed `getContext` cannot leak between cases.
 * Context creation throws on some drivers rather than returning null, so
 * the call is guarded — a browser that throws here has no WebGL 2 either.
 */
export function hasWebGL2(
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): boolean {
  try {
    return createCanvas().getContext('webgl2') != null
  } catch {
    return false
  }
}
