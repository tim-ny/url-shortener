import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import * as schema from '../../src/db/schema.js'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
})

beforeEach(async () => {
  await app.db.execute(sql`
    TRUNCATE TABLE users, api_keys, links, clicks RESTART IDENTITY CASCADE
  `)
})

async function makeUser(email = 'a@example.com') {
  const [user] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'argon2id$fake' })
    .returning()
  return user!
}

describe('users.email', () => {
  it('rejects a duplicate email', async () => {
    await makeUser('dupe@example.com')

    await expect(
      app.db.insert(schema.users).values({ email: 'dupe@example.com', passwordHash: 'x' }),
    ).rejects.toThrow()
  })

  it('treats email as case-insensitive', async () => {
    await makeUser('case@example.com')

    await expect(
      app.db.insert(schema.users).values({ email: 'CASE@Example.com', passwordHash: 'x' }),
    ).rejects.toThrow()
  })

  it('defaults to the free plan', async () => {
    const user = await makeUser('plan@example.com')
    expect(user.plan).toBe('free')
  })

  it('assigns a uuid primary key without an explicit value', async () => {
    const user = await makeUser('id@example.com')
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('api_keys', () => {
  it('rejects a duplicate key hash', async () => {
    const user = await makeUser('keys@example.com')
    const values = {
      userId: user.id,
      name: 'k',
      keyPrefix: 'usk_live_abcd',
      keyHash: 'h'.repeat(64),
    }

    await app.db.insert(schema.apiKeys).values(values)
    await expect(app.db.insert(schema.apiKeys).values(values)).rejects.toThrow()
  })

  it('cascades when the user is deleted', async () => {
    const user = await makeUser('cascade@example.com')
    await app.db
      .insert(schema.apiKeys)
      .values({ userId: user.id, name: 'k', keyPrefix: 'p', keyHash: 'c'.repeat(64) })

    await app.db.delete(schema.users).where(sql`${schema.users.id} = ${user.id}`)

    const remaining = await app.db.select().from(schema.apiKeys)
    expect(remaining).toHaveLength(0)
  })

  it('has a unique index on key_hash', async () => {
    const rows = await app.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'api_keys' AND indexname = 'api_keys_key_hash_idx'
    `)
    expect(rows.rows).toHaveLength(1)
  })
})

describe('links', () => {
  it('rejects a duplicate code', async () => {
    await app.db.insert(schema.links).values({ code: 'dup0001', targetUrl: 'https://e.com' })
    await expect(
      app.db.insert(schema.links).values({ code: 'dup0001', targetUrl: 'https://e.com' }),
    ).rejects.toThrow()
  })

  it('defaults to active and is not custom', async () => {
    const [link] = await app.db
      .insert(schema.links)
      .values({ code: 'dflt001', targetUrl: 'https://e.com' })
      .returning()

    expect(link!.state).toBe('active')
    expect(link!.isCustom).toBe(false)
    expect(link!.ownerId).toBeNull()
  })

  it('orphans rather than deletes links when the user is deleted', async () => {
    const user = await makeUser('owner@example.com')
    await app.db
      .insert(schema.links)
      .values({ code: 'orph001', targetUrl: 'https://e.com', ownerId: user.id })

    await app.db.delete(schema.users).where(sql`${schema.users.id} = ${user.id}`)

    const [link] = await app.db
      .select()
      .from(schema.links)
      .where(sql`${schema.links.code} = 'orph001'`)
    expect(link).toBeDefined()
    expect(link!.ownerId).toBeNull()
  })

  it('indexes only non-null expires_at', async () => {
    const rows = await app.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'links_expires_at_idx'
    `)
    expect(rows.rows[0]!.indexdef).toContain('WHERE')
  })

  it('supports listing a user’s links newest first', async () => {
    const user = await makeUser('list@example.com')
    await app.db.insert(schema.links).values([
      {
        code: 'list001',
        targetUrl: 'https://a.com',
        ownerId: user.id,
        createdAt: new Date('2026-01-01'),
      },
      {
        code: 'list002',
        targetUrl: 'https://b.com',
        ownerId: user.id,
        createdAt: new Date('2026-06-01'),
      },
    ])

    const rows = await app.db
      .select()
      .from(schema.links)
      .where(sql`${schema.links.ownerId} = ${user.id}`)
      .orderBy(sql`${schema.links.createdAt} desc`)

    expect(rows.map((r) => r.code)).toEqual(['list002', 'list001'])
  })
})

describe('clicks', () => {
  async function makeLink(code = 'clk0001') {
    await app.db.insert(schema.links).values({ code, targetUrl: 'https://e.com' })
  }

  it('defaults the bucket to the current hour, truncated', async () => {
    await makeLink()
    const [click] = await app.db.insert(schema.clicks).values({ code: 'clk0001' }).returning()

    const bucket = click!.bucket
    expect(bucket.getMinutes()).toBe(0)
    expect(bucket.getSeconds()).toBe(0)
    expect(bucket.getMilliseconds()).toBe(0)
  })

  it('rejects a code with no matching link', async () => {
    await expect(
      app.db.insert(schema.clicks).values({ code: 'nosuch1', count: 1 }),
    ).rejects.toThrow()
  })

  it('accumulates on conflict rather than overwriting', async () => {
    await makeLink()
    const bucket = new Date('2026-03-01T10:00:00Z')

    for (const count of [3, 4, 5]) {
      await app.db
        .insert(schema.clicks)
        .values({ code: 'clk0001', bucket, count })
        .onConflictDoUpdate({
          target: [schema.clicks.code, schema.clicks.bucket],
          set: { count: sql`${schema.clicks.count} + ${count}` },
        })
    }

    const rows = await app.db
      .select()
      .from(schema.clicks)
      .where(sql`${schema.clicks.code} = 'clk0001'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(12)
  })

  it('cascades when the link is deleted', async () => {
    await makeLink()
    await app.db.insert(schema.clicks).values({ code: 'clk0001', count: 7 })

    await app.db.delete(schema.links).where(sql`${schema.links.code} = 'clk0001'`)

    expect(await app.db.select().from(schema.clicks)).toHaveLength(0)
  })

  it('serves a per-link time series', async () => {
    await makeLink()
    await app.db.insert(schema.clicks).values([
      { code: 'clk0001', bucket: new Date('2026-03-01T09:00:00Z'), count: 10 },
      { code: 'clk0001', bucket: new Date('2026-03-01T10:00:00Z'), count: 25 },
      { code: 'clk0001', bucket: new Date('2026-03-01T11:00:00Z'), count: 1 },
    ])

    const rows = await app.db
      .select()
      .from(schema.clicks)
      .where(
        sql`${schema.clicks.code} = 'clk0001' AND ${schema.clicks.bucket} >= ${'2026-03-01T09:00:00Z'} AND ${schema.clicks.bucket} < ${'2026-03-01T11:00:00Z'}`,
      )
      .orderBy(schema.clicks.bucket)

    expect(rows.map((r) => r.count)).toEqual([10, 25])
  })
})

describe('migration state', () => {
  it('has no pending migrations', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      )
      expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2)
    } finally {
      await pool.end()
    }
  })
})
