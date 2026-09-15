// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Structural equality over mirrored-state values, shared by both ends
 * of the multi-monitor link.
 *
 * It lives in its own module because **both sides need the same answer
 * to the same question, and a second copy could disagree.** The control
 * window asks "did this change, and is it worth putting on the wire?"
 * (`stateAggregator.apply`); the output asks "did this change, and is it
 * worth acting on?" (`outputLink`'s store). Those are the same
 * comparison, and the failure when they diverge is silent and expensive:
 * the manager's idle heartbeat sends a **full snapshot every second**,
 * so an output whose equality is even slightly stricter rebuilds its
 * HLS instance once per second, on a projector, for the life of the
 * session.
 *
 * It is not in `protocol.ts` because that module's rule is types, names
 * and agreed numbers — the handful of functions there are grammar
 * (`outputLabel`) and narrowing (`isFullState`), not logic a caller
 * could get a different answer from.
 *
 * Pure: no DOM, no Tauri, no timers, no imports. It is loaded by the
 * control bundle and the output bundle alike, so anything with a
 * runtime cost here is paid twice.
 */

/**
 * `Object.hasOwn` in a codebase whose `tsconfig` targets ES2020.
 *
 * Own-property, not `in`: an inherited key must not be read as a present
 * value, or a patch could "contain" a key it never set.
 */
export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * Deep structural equality.
 *
 * These values cross a structured-clone boundary by contract (see
 * `protocol.ts`), so they are plain data all the way down and a
 * recursive compare is exact rather than approximate.
 *
 * `JSON.stringify` would be shorter and wrong: it is key-order
 * sensitive, so two objects built by different call sites with the same
 * fields would compare unequal and re-broadcast forever.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    return x.length === y.length && x.every((v, i) => sameValue(v, y[i]))
  }

  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  if (keys.length !== Object.keys(y).length) return false
  return keys.every(k => hasOwn(y, k) && sameValue(x[k], y[k]))
}
