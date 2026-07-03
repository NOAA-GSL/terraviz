/**
 * `node_profile` singleton row helpers (`migrations/catalog/0028_node_profile.sql`).
 *
 * The operator-authored "about the host organization" context — the
 * Phase 3d blog generator grounds AI drafts in it so they speak in
 * the node's own voice, and it is generic enough to back other
 * identity surfaces later (about page, footer attribution).
 *
 * Mirrors `hero-override-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler
 * (privileged-only writes via `isPrivileged`). Absence of a row means
 * "profile not filled in yet" — every consumer degrades gracefully.
 */

import type { PublisherRow } from './publisher-store'

/** Bounds keep the stored payload (and any prompt it is interpolated
 *  into) small. Generous for prose, hostile to paste-bombs. */
export const PROFILE_ORG_NAME_MAX_LEN = 200
export const PROFILE_MISSION_MAX_LEN = 1_000
export const PROFILE_ABOUT_MAX_LEN = 10_000
export const PROFILE_REGION_MAX_LEN = 200
export const PROFILE_TONE_MAX_LEN = 200
export const PROFILE_MAX_LINKS = 10
export const PROFILE_LINK_LABEL_MAX_LEN = 100

/** The `node_profile` row as stored. */
export interface NodeProfileRow {
  org_name: string
  mission: string | null
  about_md: string | null
  region_focus: string | null
  default_tone: string | null
  links_json: string | null
  updated_by: string
  updated_at: string
}

export interface NodeProfileLink {
  label: string
  url: string
}

/** The wire shape the portal reads and writes. */
export interface NodeProfilePublic {
  orgName: string
  mission: string | null
  aboutMd: string | null
  regionFocus: string | null
  defaultTone: string | null
  links: NodeProfileLink[]
  updatedBy: string
  updatedAt: string
}

/** Fetch the singleton profile row, or null when never filled in. */
export async function getNodeProfile(db: D1Database): Promise<NodeProfileRow | null> {
  const row = await db
    .prepare(
      `SELECT org_name, mission, about_md, region_focus, default_tone,
              links_json, updated_by, updated_at
         FROM node_profile
        WHERE id = 1
        LIMIT 1`,
    )
    .first<NodeProfileRow>()
  return row ?? null
}

/** Shape a stored row into the wire payload. A corrupt `links_json`
 *  degrades to an empty list rather than failing the read. */
export function toPublicProfile(row: NodeProfileRow): NodeProfilePublic {
  let links: NodeProfileLink[] = []
  if (row.links_json) {
    try {
      const parsed: unknown = JSON.parse(row.links_json)
      if (Array.isArray(parsed)) {
        links = parsed.filter(
          (l): l is NodeProfileLink =>
            !!l && typeof l === 'object'
            && typeof (l as NodeProfileLink).label === 'string'
            && typeof (l as NodeProfileLink).url === 'string',
        )
      }
    } catch {
      // Corrupt JSON — treat as no links.
    }
  }
  return {
    orgName: row.org_name,
    mission: row.mission,
    aboutMd: row.about_md,
    regionFocus: row.region_focus,
    defaultTone: row.default_tone,
    links,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

/** A validated `PUT` body, ready for {@link setNodeProfile}. */
export interface ValidatedProfileInput {
  org_name: string
  mission: string | null
  about_md: string | null
  region_focus: string | null
  default_tone: string | null
  links_json: string | null
}

/** Upsert the singleton profile. */
export async function setNodeProfile(
  db: D1Database,
  publisher: PublisherRow,
  input: ValidatedProfileInput,
  now: string = new Date().toISOString(),
): Promise<NodeProfileRow> {
  await db
    .prepare(
      `INSERT INTO node_profile
         (id, org_name, mission, about_md, region_focus, default_tone,
          links_json, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         org_name     = excluded.org_name,
         mission      = excluded.mission,
         about_md     = excluded.about_md,
         region_focus = excluded.region_focus,
         default_tone = excluded.default_tone,
         links_json   = excluded.links_json,
         updated_by   = excluded.updated_by,
         updated_at   = excluded.updated_at`,
    )
    .bind(
      input.org_name,
      input.mission,
      input.about_md,
      input.region_focus,
      input.default_tone,
      input.links_json,
      publisher.id,
      now,
    )
    .run()
  return {
    org_name: input.org_name,
    mission: input.mission,
    about_md: input.about_md,
    region_focus: input.region_focus,
    default_tone: input.default_tone,
    links_json: input.links_json,
    updated_by: publisher.id,
    updated_at: now,
  }
}

/** A single body-validation error in the publisher-API array shape. */
export interface FieldError {
  field: string
  code: string
  message: string
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maxLen: number,
  errors: FieldError[],
): string | null {
  const raw = body[field]
  if (raw == null) return null
  if (typeof raw !== 'string') {
    errors.push({ field, code: 'invalid', message: `\`${field}\` must be a string.` })
    return null
  }
  if (raw.length > maxLen) {
    errors.push({ field, code: 'too_long', message: `\`${field}\` must be at most ${maxLen} characters.` })
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** True for the http(s) URLs the profile is allowed to link out to —
 *  the same scheme guard the events surfaces apply to source URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a `PUT /api/v1/publish/node-profile` body. Only `orgName`
 * is mandatory — a node can fill in the rest over time. Links are
 * validated as `{label, url}` pairs with http(s) urls; anything else
 * is a field error rather than a silent drop, so the operator sees
 * what the form refused.
 */
export function validateProfileInput(
  raw: unknown,
): { ok: true; value: ValidatedProfileInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const orgNameRaw = body.orgName
  let orgName = ''
  if (typeof orgNameRaw !== 'string' || orgNameRaw.trim().length === 0) {
    errors.push({ field: 'orgName', code: 'required', message: '`orgName` is required.' })
  } else if (orgNameRaw.length > PROFILE_ORG_NAME_MAX_LEN) {
    errors.push({ field: 'orgName', code: 'too_long', message: `\`orgName\` must be at most ${PROFILE_ORG_NAME_MAX_LEN} characters.` })
  } else {
    orgName = orgNameRaw.trim()
  }

  const mission = optionalText(body, 'mission', PROFILE_MISSION_MAX_LEN, errors)
  const aboutMd = optionalText(body, 'aboutMd', PROFILE_ABOUT_MAX_LEN, errors)
  const regionFocus = optionalText(body, 'regionFocus', PROFILE_REGION_MAX_LEN, errors)
  const defaultTone = optionalText(body, 'defaultTone', PROFILE_TONE_MAX_LEN, errors)

  let linksJson: string | null = null
  if (body.links != null) {
    if (!Array.isArray(body.links)) {
      errors.push({ field: 'links', code: 'invalid', message: '`links` must be an array of {label, url}.' })
    } else if (body.links.length > PROFILE_MAX_LINKS) {
      errors.push({ field: 'links', code: 'too_many', message: `\`links\` must have at most ${PROFILE_MAX_LINKS} entries.` })
    } else {
      const links: NodeProfileLink[] = []
      for (let i = 0; i < body.links.length; i++) {
        const l = body.links[i] as Record<string, unknown> | null
        const label = l && typeof l.label === 'string' ? l.label.trim() : ''
        const url = l && typeof l.url === 'string' ? l.url.trim() : ''
        if (!label || label.length > PROFILE_LINK_LABEL_MAX_LEN || !isHttpUrl(url)) {
          errors.push({
            field: `links[${i}]`,
            code: 'invalid',
            message: 'Each link needs a non-empty label and an http(s) url.',
          })
          continue
        }
        links.push({ label, url })
      }
      if (links.length > 0) linksJson = JSON.stringify(links)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      org_name: orgName,
      mission,
      about_md: aboutMd,
      region_focus: regionFocus,
      default_tone: defaultTone,
      links_json: linksJson,
    },
  }
}
