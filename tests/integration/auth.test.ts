import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { captureLogs, NO_RATE_LIMITS, truncateAll } from '../helpers.js'
import {
  hashApiKey,
  isWellFormedApiKey,
  KEY_PREFIX_TEST,
} from '../../src/modules/auth/key-generator.js'
import { verifyPassword } from '../../src/modules/auth/password.js'
import { apiKeys, users } from '../../src/db/schema.js'
import { AppError } from '../../src/lib/errors.js'

let app: FastifyInstance

const PASSWORD = 'a-sufficiently-long-password'

beforeAll(async () => {
  app = await buildApp({ rateLimits: NO_RATE_LIMITS })
})

afterAll(async () => {
  await app?.close()
})

beforeEach(async () => {
  await truncateAll(app)
})

interface UserBody {
  id: string
  email: string
  plan: string
  createdAt: string
}

interface IssuedKeyBody {
  id: string
  key: string
  prefix: string
  createdAt: string
}

interface ErrorBody {
  error: { code: string; message: string }
}

type CredentialsResponse = { user: UserBody; apiKey: IssuedKeyBody }

function auth(key: string) {
  return { authorization: `Bearer ${key}` }
}

function asError(body: unknown): ErrorBody {
  const parsed = body as CredentialsResponse | ErrorBody
  if (!('error' in parsed)) throw new Error('expected an error response, got a success body')
  return parsed
}

function asCredentials(body: unknown): CredentialsResponse {
  const parsed = body as CredentialsResponse | ErrorBody
  if ('error' in parsed) throw new Error(`expected a success body, got ${parsed.error.code}`)
  return parsed
}

async function register(email = 'user@example.com', keyName?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, ...(keyName ? { keyName } : {}) },
  })

  const body = response.json<CredentialsResponse | ErrorBody>()

  return {
    status: response.statusCode,
    body,
    key: 'apiKey' in body ? body.apiKey.key : '',
  }
}

async function login(email: string, password = PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  })

  return {
    status: response.statusCode,
    body: response.json<CredentialsResponse | ErrorBody>(),
  }
}

async function userRowByEmail(email: string) {
  const rows = await app.db
    .select()
    .from(users)
    .where(sql`${users.email} = ${email}`)
    .limit(1)
  return rows[0]
}

describe('POST /v1/auth/register', () => {
  it('creates an account and returns a usable API key', async () => {
    const { status, body, key } = await register()

    expect(status).toBe(201)
    expect(asCredentials(body).user.email).toBe('user@example.com')
    expect(asCredentials(body).user.plan).toBe('free')
    expect(isWellFormedApiKey(key)).toBe(true)

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(key) })
    expect(me.statusCode).toBe(200)
  })

  it('stores the password as an argon2id hash, never plaintext', async () => {
    await register()
    const row = await userRowByEmail('user@example.com')

    expect(row!.passwordHash).not.toContain(PASSWORD)
    expect(row!.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(row!.passwordHash, PASSWORD)).toBe(true)
  })

  it('stores only the HMAC of the key', async () => {
    const { key } = await register()
    const rows = await app.db.select().from(apiKeys)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyHash).toBe(hashApiKey(key))
    expect(rows[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows[0])).not.toContain(key)
  })

  it('stores a display prefix but not the full key', async () => {
    const { key } = await register()
    const [row] = await app.db.select().from(apiKeys)

    expect(row!.keyPrefix.startsWith(KEY_PREFIX_TEST)).toBe(true)
    expect(row!.keyPrefix).toHaveLength(KEY_PREFIX_TEST.length + 4)
    expect(row!.keyPrefix.length).toBeLessThan(key.length)
  })

  it('issues a different key on each registration', async () => {
    const first = await register('a@example.com')
    const second = await register('b@example.com')

    expect(first.key).not.toBe(second.key)
  })

  it('rejects a duplicate email regardless of case', async () => {
    await register('dup@example.com')
    const { status, body } = await register('DUP@Example.com')

    expect(status).toBe(409)
    expect(asError(body).error.code).toBe('email_taken')
  })

  it('rejects a password below the configured minimum', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'short@example.com', password: 'a'.repeat(8) },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('validation_failed')
  })

  it('rejects a malformed email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: PASSWORD },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects unknown properties rather than ignoring them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'a@example.com', password: PASSWORD, isAdmin: true },
    })

    expect(response.statusCode).toBe(400)
  })

  it('never returns the stored hashes', async () => {
    const { body } = await register()
    const credentials = asCredentials(body)

    expect(credentials.user).not.toHaveProperty('passwordHash')
    expect(credentials.apiKey).not.toHaveProperty('keyHash')
  })
})

describe('POST /v1/auth/login', () => {
  it('exchanges credentials for a fresh key', async () => {
    await register()

    const { status, body } = await login('user@example.com')

    expect(status).toBe(200)
    expect(isWellFormedApiKey(asCredentials(body).apiKey.key)).toBe(true)
  })

  it('issues a new key each time without invalidating the old one', async () => {
    const first = await register()

    const second = (await login('user@example.com')).body as CredentialsResponse

    expect(second.apiKey.key).not.toBe(first.key)

    for (const key of [first.key, second.apiKey.key]) {
      const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(key) })
      expect(me.statusCode).toBe(200)
    }
  })

  it('is case-insensitive on the email, because the column is citext', async () => {
    await register('mixed@example.com')

    expect((await login('MiXeD@Example.com')).status).toBe(200)
  })

  it('rejects a wrong password with 401', async () => {
    await register()

    const { status, body } = await login('user@example.com', 'the-wrong-password')

    expect(status).toBe(401)
    expect(asError(body).error.code).toBe('invalid_credentials')
  })

  it('gives an unknown email the same response as a wrong password', async () => {
    await register('real@example.com')

    const wrongPassword = await login('real@example.com', 'not-the-password')
    const unknownEmail = await login('nobody@example.com', 'not-the-password')

    expect(unknownEmail.status).toBe(wrongPassword.status)
    expect(unknownEmail.body).toEqual(wrongPassword.body)
  })

  it('creates no account as a side effect of a failed login', async () => {
    await login('ghost@example.com')

    expect(await userRowByEmail('ghost@example.com')).toBeUndefined()
  })
})

describe('GET /v1/auth/me', () => {
  it('returns the caller and their plan', async () => {
    const { key } = await register()

    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(key) })

    expect(response.statusCode).toBe(200)
    expect(response.json().user.email).toBe('user@example.com')
    expect(response.json().user.plan).toBe('free')
  })

  it('rejects a request with no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an unknown key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(`usk_test_${'a'.repeat(43)}`),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a malformed key without a database round trip', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth('garbage'),
    })

    expect(response.statusCode).toBe(401)
  })

  it('sets WWW-Authenticate on 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' })

    expect(response.headers['www-authenticate']).toContain('Bearer')
  })

  it('rejects a key whose account is gone', async () => {
    const { key } = await register()
    await app.db.execute(sql`DELETE FROM users`)

    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(key) })

    expect(response.statusCode).toBe(401)
  })

  it('updates last_used_at, without blocking the response on it', async () => {
    const { key } = await register()

    await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(key) })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const [row] = await app.db.select().from(apiKeys)
    expect(row!.lastUsedAt).not.toBeNull()
  })
})

describe('GET /v1/auth/keys', () => {
  it('lists the caller’s keys, newest first, without the secrets', async () => {
    const first = await register('user@example.com', 'laptop')
    const second = (await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'user@example.com', password: PASSWORD, keyName: 'ci' },
    })).json().apiKey.key

    const response = await app.inject({ method: 'GET', url: '/v1/auth/keys', headers: auth(first.key) })

    expect(response.statusCode).toBe(200)

    const keys = response.json().keys
    expect(keys).toHaveLength(2)
    expect(keys[0].name).toBe('ci')

    const serialised = JSON.stringify(response.json())
    expect(serialised).not.toContain(first.key)
    expect(serialised).not.toContain(second)
  })

  it('does not list another user’s keys', async () => {
    const { key } = await register('mine@example.com')
    await register('theirs@example.com')

    const response = await app.inject({ method: 'GET', url: '/v1/auth/keys', headers: auth(key) })

    expect(response.json().keys).toHaveLength(1)
  })

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/keys' })

    expect(response.statusCode).toBe(401)
  })
})

describe('DELETE /v1/auth/keys/:id', () => {
  it('revokes a key and stops it working immediately', async () => {
    const first = await register()
    const second = asCredentials((await login('user@example.com')).body).apiKey.key

    const [row] = await app.db.select().from(apiKeys)
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/keys/${row!.id}`,
      headers: auth(second),
    })
    expect(revoked.statusCode).toBe(204)

    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(first.key) }))
        .statusCode,
    ).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(second) })).statusCode,
    ).toBe(200)
  })

  it('keeps the revoked row rather than deleting it, for the audit trail', async () => {
    const { key } = await register()
    const [row] = await app.db.select().from(apiKeys)

    await app.inject({ method: 'DELETE', url: `/v1/auth/keys/${row!.id}`, headers: auth(key) })

    const after = await app.db.select().from(apiKeys)
    expect(after).toHaveLength(1)
    expect(after[0]!.revokedAt).not.toBeNull()
  })

  it('returns 404, not 403, for another user’s key', async () => {
    const { key } = await register('mine@example.com')
    await register('theirs@example.com')

    const [theirKey] = await app.db.select().from(apiKeys).where(
      sql`${apiKeys.name} = 'default' AND ${apiKeys.userId} != (SELECT id FROM users WHERE email = 'mine@example.com')`,
    )

    const theirs = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/keys/${theirKey!.id}`,
      headers: auth(key),
    })
    const nonexistent = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/keys/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
      headers: auth(key),
    })

    expect(theirs.statusCode).toBe(404)
    expect(nonexistent.statusCode).toBe(theirs.statusCode)
    expect(nonexistent.json()).toEqual(theirs.json())
  })

  it('leaves the other user’s key working', async () => {
    const { key } = await register('mine@example.com')
    const theirs = await register('theirs@example.com')

    const [theirKey] = await app.db
      .select()
      .from(apiKeys)
      .where(sql`${apiKeys.userId} != (SELECT id FROM users WHERE email = 'mine@example.com')`)

    await app.inject({
      method: 'DELETE',
      url: `/v1/auth/keys/${theirKey!.id}`,
      headers: auth(key),
    })

    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(theirs.key) }))
        .statusCode,
    ).toBe(200)
  })

  it('requires authentication, and revokes nothing without it', async () => {
    await register()
    const [row] = await app.db.select().from(apiKeys)

    const response = await app.inject({ method: 'DELETE', url: `/v1/auth/keys/${row!.id}` })
    expect(response.statusCode).toBe(401)

    const after = await app.db.select().from(apiKeys)
    expect(after[0]!.revokedAt).toBeNull()
  })

  it('rejects a non-uuid id', async () => {
    const { key } = await register()

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/keys/not-a-uuid',
      headers: auth(key),
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('logging', () => {
  it('keeps the key and password out of the log output', async () => {
    const logs = captureLogs()
    const logged = await buildApp({ logSink: logs.sink, rateLimits: NO_RATE_LIMITS })

    try {
      const registered = await logged.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'logged@example.com', password: PASSWORD },
      })
      const apiKey = asCredentials(registered.json()).apiKey.key

      const me = await logged.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: auth(apiKey),
      })
      expect(me.statusCode).toBe(200)

      const output = await logs.read()
      expect(output).not.toContain(apiKey)
      expect(output).not.toContain(PASSWORD)
      expect(output).not.toContain(apiKey.slice(KEY_PREFIX_TEST.length, KEY_PREFIX_TEST.length + 8))
    } finally {
      await logged.close()
    }
  })

  it('returns a generic 500 and keeps the detail in the log', async () => {
    const logs = captureLogs()
    const broken = await buildApp({ logSink: logs.sink, rateLimits: NO_RATE_LIMITS })

    try {
      broken.get('/boom', () => {
        throw new Error('select * from users where password_hash = $1 -- hunter2')
      })

      const response = await broken.inject({ method: 'GET', url: '/boom' })

      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({
        error: { code: 'internal_error', message: 'Internal server error.' },
      })
      expect(await logs.read()).toContain('hunter2')
      expect(response.body).not.toContain('hunter2')
    } finally {
      await broken.close()
    }
  })

  it('renders a thrown AppError as its own status and code', async () => {
    const broken = await buildApp({ logSink: captureLogs().sink, rateLimits: NO_RATE_LIMITS })

    try {
      broken.get('/app-error', () => {
        throw new AppError('bad_request', 400, 'destination url is not allowed')
      })

      const response = await broken.inject({ method: 'GET', url: '/app-error' })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({
        error: { code: 'bad_request', message: 'destination url is not allowed' },
      })
    } finally {
      await broken.close()
    }
  })
})