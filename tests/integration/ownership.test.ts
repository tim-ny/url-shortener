import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { authenticate, requireOwner } from '../../src/modules/auth/guards.js'
import { links } from '../../src/db/schema.js'

let app: FastifyInstance

const PASSWORD = 'a-sufficiently-long-password'
const OWNED = 'own0001'
const THEIRS = 'theirs1'
const MISSING = 'nope001'

beforeAll(async () => {
  app = await buildApp({ rateLimitOverrides: { register: 10_000, auth: 10_000 } })

  app.get('/probe/owned/:code', { preHandler: [authenticate, requireOwner] }, (request) => ({
    ok: true,
    code: (request.params as { code: string }).code,
  }))

  app.get('/probe/optional/:code', { preHandler: [requireOwner] }, (request) => ({
    ok: true,
    code: (request.params as { code: string }).code,
  }))
})

afterAll(async () => {
  await app?.close()
})

beforeEach(async () => {
  await app.db.execute(sql`TRUNCATE TABLE users, api_keys, links, clicks RESTART IDENTITY CASCADE`)
  await app.db.insert(links).values([
    { code: OWNED, targetUrl: 'https://owned.example.com', ownerId: null },
    { code: THEIRS, targetUrl: 'https://theirs.example.com', ownerId: null },
  ])
})

async function userWithLink(code: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `${code}@example.com`, password: PASSWORD },
  })
  const key: string = response.json().apiKey.key
  const ownerId: string = response.json().user.id

  await app.db
    .update(links)
    .set({ ownerId })
    .where(sql`${links.code} = ${code}`)

  return key
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` }
}

describe('requireOwner', () => {
  it('passes for the owner', async () => {
    const key = await userWithLink(OWNED)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().code).toBe(OWNED)
  })

  it('returns 404 for another user’s link, not 403', async () => {
    const key = await userWithLink(THEIRS)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(404)
  })

  it('gives a byte-identical response for unowned and nonexistent', async () => {
    const key = await userWithLink(THEIRS)

    const unowned = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })
    const missing = await app.inject({
      method: 'GET',
      url: `/probe/owned/${MISSING}`,
      headers: auth(key),
    })

    expect(unowned.statusCode).toBe(missing.statusCode)
    expect(unowned.headers['content-type']).toBe(missing.headers['content-type'])
    expect(unowned.body).toBe(missing.body)
  })

  it('treats an anonymous link as unowned by everyone', async () => {
    const key = await userWithLink(THEIRS)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(404)
  })

  it('requires authentication first', async () => {
    const response = await app.inject({ method: 'GET', url: `/probe/owned/${OWNED}` })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a revoked key even for a link it owned', async () => {
    const key = await userWithLink(OWNED)

    await app.db.execute(
      sql`UPDATE api_keys SET revoked_at = now()
          WHERE user_id = (SELECT id FROM users WHERE email = ${OWNED + '@example.com'})`,
    )

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(401)
  })

  it('does not treat a null owner as a match', async () => {
    const key = await userWithLink(THEIRS)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/optional/${OWNED}`,
      headers: auth(key),
    })

    expect([401, 404]).toContain(response.statusCode)
  })
})
