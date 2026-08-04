import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredNodeMajor, requiredNodeLabel, NODE_DOWNLOAD_URL } from './node-version'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

describe('requiredNodeMajor', () => {
  it('reads the major out of engines.node', () => {
    expect(requiredNodeMajor()).toBeGreaterThanOrEqual(18)
    expect(requiredNodeLabel()).toBe(`${requiredNodeMajor()}+`)
  })
})

/**
 * The prose has to agree with `engines`.
 *
 * This is the check that would have caught the state this was written
 * in: `engines` said 22, CI ran 22, the install guide asked for 20
 * twice, and the README asked for 18. Nothing failed, because npm only
 * warns without `engine-strict` — so the docs were free to drift and
 * did, in three different directions.
 *
 * Matching on "Node.js <n>" rather than on an exact sentence keeps
 * this from being a prose lint: rewrite the sentences freely, just do
 * not name a version the repo does not require.
 */
describe('the documented Node version', () => {
  const docs = [
    'docs/SELF_HOSTING.md',
    'README.md',
    'docs/CATALOG_BACKEND_DEVELOPMENT.md',
  ]

  for (const path of docs) {
    it(`${path} names no Node version other than engines'`, () => {
      const major = requiredNodeMajor()
      const text = read(path)
      // Catches every shape the four stale claims used: "Node.js 20+",
      // "Node.js 18+", "Node.js ≥ 20.10" and a bare "Node 22".
      const named = [...text.matchAll(/Node(?:\.js)?\s*(?:[≥>=v]+\s*)?(\d{2})/gi)].map(
        m => Number(m[1]),
      )
      for (const n of named) {
        expect(n, `${path} asks for Node ${n}, engines requires ${major}`).toBe(major)
      }
    })
  }

  it('tells the reader where to get it', () => {
    expect(read('docs/SELF_HOSTING.md')).toContain(NODE_DOWNLOAD_URL)
  })

  // The sheet is the surface an operator prints, and it runs `npm` at
  // step 6 — it cannot be the one document that never mentions Node.
  it('reaches the generated install console', () => {
    const page = read('public/setup.html')
    expect(page).toContain(`Node.js ${requiredNodeLabel()}`)
    expect(page).toContain(NODE_DOWNLOAD_URL)
  })
})
