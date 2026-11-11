import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { env } from '../../src/config/env.js'

const PASSWORD = 'a-sufficiently-long-password'

/** Rate-limit counters live in Redis, so they outlive app.close(). */
async function clearCounters(app: FastifyInstance): Promise<void> {
  const keys = await app.cache.keys('shortener:rl:*')
  if (keys.length > 0) await app.cache.del(...keys)
}

async function freshApp(): Promise<FastifyInstance> {
  const app = await buildApp()
  await clearCounters(app)
  return app
}

describe('register rate limit', () => {
  it('returns 429 with a retry hint once the budget is spent', async () => {
    const app = await freshApp()

    try {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email: `rl-${Math.random()}@example.com`, password: PASSWORD },
        })

      for (let i = 0; i < env.RATE_LIMIT_REGISTER_MAX; i += 1) {
        expect((await attempt()).statusCode, `request ${i + 1} should be allowed`).toBe(201)
      }

      const blocked = await attempt()

      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers['retry-after']).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('shares one counter across app instances', async () => {
    const first = await buildApp()
    const second = await buildApp()

    try {
      await clearCounters(first)

      const spend = (target: FastifyInstance) =>
        target.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email: `shared-${Math.random()}@example.com`, password: PASSWORD },
        })

      // Two instances, one budget: without the Redis store the plugin would keep
      // an in-memory counter per instance and allow N times the intended limit.
      const half = Math.ceil(env.RATE_LIMIT_REGISTER_MAX / 2)
      for (let i = 0; i < half; i += 1) {
        expect((await spend(first)).statusCode).toBe(201)
      }
      for (let i = 0; i < half; i += 1) {
        await spend(second)
      }

      expect((await spend(second)).statusCode).toBe(429)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('does not leak whether a request would have been accepted', async () => {
    const app = await freshApp()

    try {
      const attempts = Array.from({ length: env.RATE_LIMIT_REGISTER_MAX + 4 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email: `burst-${Math.random()}@example.com`, password: PASSWORD },
        }),
      )
      const responses = await Promise.all(attempts)
      const limited = responses.filter((response) => response.statusCode === 429)

      expect(limited.length).toBeGreaterThan(0)

      for (const response of limited) {
        expect(Object.keys(response.json())).toEqual(['error'])
        expect(response.json().error.code).toBe('rate_limited')
      }
    } finally {
      await app.close()
    }
  })
})

describe('login rate limit', () => {
  it('is looser than register, so a typo is not a lockout', async () => {
    expect(env.RATE_LIMIT_LOGIN_MAX).toBeGreaterThan(env.RATE_LIMIT_REGISTER_MAX)

    const app = await freshApp()

    try {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: `ghost-${Math.random()}@example.com`, password: PASSWORD },
        })

      for (let i = 0; i < env.RATE_LIMIT_LOGIN_MAX; i += 1) {
        expect((await attempt()).statusCode, `request ${i + 1} should be allowed`).toBe(401)
      }

      expect((await attempt()).statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })
})