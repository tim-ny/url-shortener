import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { authenticate, requireOwner } from '../../src/modules/auth/guards.js'
import { links } from '../../src/db/schema.js'
import { NO_RATE_LIMITS, truncateAll } from '../helpers.js'

let app: FastifyInstance

const PASSWORD = 'a-sufficiently-long-password'
const OWNED = 'own0001'
const THEIRS = 'theirs1'
const MISSING = 'nope001'

beforeAll(async () => {
  app = await buildApp({ rateLimits: NO_RATE_LIMITS })

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
  await truncateAll(app)
  await app.db.insert(links).values([
    { code: OWNED, targetUrl: 'https://owned.example.com', ownerId: null },
    { code: THEIRS, targetUrl: 'https://theirs.example.com', ownerId: null },
  ])
})

/** Registers a user and makes them the owner of `code`. Returns their API key. */
async function ownerOf(code: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `${code}@example.com`, password: PASSWORD },
  })
  const { apiKey, user } = response.json()

  await app.db.update(links).set({ ownerId: user.id }).where(sql`${links.code} = ${code}`)

  return apiKey.key as string
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` }
}

describe('requireOwner', () => {
  it('passes for the owner', async () => {
    const key = await ownerOf(OWNED)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().code).toBe(OWNED)
  })

  it('returns 404 for another user’s link, not 403', async () => {
    const key = await ownerOf(THEIRS)

    const response = await app.inject({
      method: 'GET',
      url: `/probe/owned/${OWNED}`,
      headers: auth(key),
    })

    expect(response.statusCode).toBe(404)
  })

  it('gives a byte-identical response for unowned and nonexistent', async () => {
    const key = await ownerOf(THEIRS)

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

    expect(missing.statusCode).toBe(unowned.statusCode)
    expect(missing.headers['content-type']).toBe(unowned.headers['content-type'])
    expect(missing.body).toBe(unowned.body)
  })

  it('treats an anonymous link as unowned by everyone', async () => {
    const key = await ownerOf(THEIRS)

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
    const key = await ownerOf(OWNED)

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

  it('refuses to run without an authenticated principal', async () => {
    // The anonymous-owner case is covered above, through an authenticated
    // request. This route skips `authenticate`, so the guard has nothing to
    // compare an owner against.
    const response = await app.inject({ method: 'GET', url: `/probe/optional/${OWNED}` })

    expect(response.statusCode).toBe(401)
  })
})