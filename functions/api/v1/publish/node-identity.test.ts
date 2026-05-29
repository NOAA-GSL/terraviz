import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { onRequestGet, onRequestPut } from './node-identity'
import { asD1, makeKV } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE node_identity (
      node_id       TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      base_url      TEXT NOT NULL,
      description   TEXT,
      contact_email TEXT,
      public_key    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
  `)
  return db
}

const ADMIN: PublisherRow = {
  id: 'PUB_ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}

const SERVICE: PublisherRow = { ...ADMIN, id: 'PUB_SVC', role: 'service', is_admin: 0 }
const COMMUNITY: PublisherRow = { ...ADMIN, id: 'PUB_C', role: 'community', is_admin: 0 }

function putCtx(db: Database.Database, publisher: PublisherRow, body: unknown, kv = makeKV()) {
  return {
    request: new Request('https://node.example.org/api/v1/publish/node-identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { CATALOG_DB: asD1(db), CATALOG_KV: kv },
    params: {},
    data: { publisher },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/node-identity',
  } as unknown as Parameters<PagesFunction>[0]
}

async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

describe('PUT /api/v1/publish/node-identity', () => {
  it('provisions a fresh identity for an admin and busts the snapshot', async () => {
    const db = freshDb()
    const kv = makeKV()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'Terraviz — Acme',
        base_url: 'https://terraviz.acme.org',
        contact_email: 'ops@acme.org',
        public_key: 'ed25519:abc123',
      }, kv),
    )
    expect(res.status).toBe(200)
    const { identity } = await bodyOf(res)
    expect(identity.display_name).toBe('Terraviz — Acme')
    expect(identity.base_url).toBe('https://terraviz.acme.org')
    expect(identity.public_key).toBe('ed25519:abc123')
    expect(identity.node_id).toBeTruthy()
    // Row actually written.
    const row = db.prepare('SELECT * FROM node_identity').get() as any
    expect(row.contact_email).toBe('ops@acme.org')
    // Snapshot invalidated.
    expect(kv.delete).toHaveBeenCalled()
  })

  it('rejects a fresh provision without a public key', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'No Key',
        base_url: 'https://no-key.example.org',
      }),
    )
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toBe('validation_failed')
    expect(body.errors.some((e: any) => e.field === 'public_key' && e.code === 'required')).toBe(true)
  })

  it('updates an existing row, preserving node_id and keeping the key when omitted', async () => {
    const db = freshDb()
    db.prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, description, contact_email, public_key, created_at)
       VALUES ('NODE1', 'Old', 'https://old.example.org', NULL, NULL, 'ed25519:original', '2026-01-01T00:00:00.000Z')`,
    ).run()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'New Name',
        base_url: 'https://new.example.org',
      }),
    )
    expect(res.status).toBe(200)
    const { identity } = await bodyOf(res)
    expect(identity.node_id).toBe('NODE1')
    expect(identity.display_name).toBe('New Name')
    expect(identity.public_key).toBe('ed25519:original') // unchanged
    expect(identity.created_at).toBe('2026-01-01T00:00:00.000Z') // preserved
    // Exactly one row (update, not insert).
    expect((db.prepare('SELECT count(*) c FROM node_identity').get() as any).c).toBe(1)
  })

  it('rejects an invalid base_url', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, ADMIN, { display_name: 'X', base_url: 'ftp://nope', public_key: 'ed25519:k' }),
    )
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.errors.some((e: any) => e.field === 'base_url')).toBe(true)
  })

  it('allows a service token (bootstrap credential)', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, SERVICE, {
        display_name: 'Svc Provisioned',
        base_url: 'https://svc.example.org',
        public_key: 'ed25519:svc',
      }),
    )
    expect(res.status).toBe(200)
  })

  it('forbids a non-admin, non-service publisher', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, COMMUNITY, {
        display_name: 'Nope',
        base_url: 'https://nope.example.org',
        public_key: 'ed25519:k',
      }),
    )
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toBe('forbidden')
    expect(db.prepare('SELECT count(*) c FROM node_identity').get()).toMatchObject({ c: 0 })
  })

  it('rejects a non-JSON body', async () => {
    const db = freshDb()
    const ctx = {
      request: new Request('https://node.example.org/api/v1/publish/node-identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      env: { CATALOG_DB: asD1(db), CATALOG_KV: makeKV() },
      params: {},
      data: { publisher: ADMIN },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/v1/publish/node-identity',
    } as unknown as Parameters<PagesFunction>[0]
    const res = await onRequestPut(ctx)
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error).toBe('invalid_json')
  })
})

describe('GET /api/v1/publish/node-identity', () => {
  it('returns null on a fresh deploy and the row once provisioned', async () => {
    const db = freshDb()
    const ctxOpts = () =>
      ({
        request: new Request('https://node.example.org/api/v1/publish/node-identity'),
        env: { CATALOG_DB: asD1(db) },
        params: {},
        data: { publisher: ADMIN },
        waitUntil: () => {},
        passThroughOnException: () => {},
        next: async () => new Response(null),
        functionPath: '/api/v1/publish/node-identity',
      }) as unknown as Parameters<PagesFunction>[0]

    let res = await onRequestGet(ctxOpts())
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).identity).toBeNull()

    db.prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, description, contact_email, public_key, created_at)
       VALUES ('N', 'D', 'https://d.example.org', NULL, NULL, 'ed25519:k', '2026-01-01T00:00:00.000Z')`,
    ).run()
    res = await onRequestGet(ctxOpts())
    expect((await bodyOf(res)).identity.node_id).toBe('N')
  })
})
