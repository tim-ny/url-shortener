import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { env } from '../../src/config/env.js'

const PASSWORD = 'a-sufficiently-long-password'

async function clearCounters(app: FastifyInstance): Promise<void> {
  const keys = await app.cache.keys('shortener:rl:*')
  if (keys.length > 0) await app.cache.del(...keys)
}

async function freshApp(): Promise<FastifyInstance> {
  const instance = await buildApp()
  await clearCounters(instance)
  return instance
}

describe('register rate limit', () => {
  it('returns 429 with a retry hint once the budget is spent', async () => {
    const limited = await freshApp()
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email: `rl-${Math.random()}@example.com`, password: PASSWORD },
        })

      for (let i = 0; i < env.RATE_LIMIT_REGISTER_MAX; i += 1) {
        const response = await attempt()
        expect(response.statusCode, `request ${i + 1} should be allowed`).toBe(201)
      }

      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)

      expect(blocked.headers['retry-after']).toBeDefined()
    } finally {
      await limited.close()
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

      for (let i = 0; i < Math.ceil(env.RATE_LIMIT_REGISTER_MAX / 2); i += 1) {
        expect((await spend(first)).statusCode).toBe(201)
      }
      for (let i = 0; i < Math.ceil(env.RATE_LIMIT_REGISTER_MAX / 2); i += 1) {
        await spend(second)
      }

      expect((await spend(second)).statusCode).toBe(429)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('does not leak whether a request would have been accepted', async () => {
    const limited = await freshApp()
    try {
      const posts = (n: number) =>
        Promise.all(
          Array.from({ length: n }, () =>
            limited.inject({
              method: 'POST',
              url: '/v1/auth/register',
              payload: { email: `burst-${Math.random()}@example.com`, password: PASSWORD },
            }),
          ),
        )

      const responses = await posts(env.RATE_LIMIT_REGISTER_MAX + 4)
      const statuses = responses.map((r) => r.statusCode)

      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)

      for (const response of responses.filter((r) => r.statusCode === 429)) {
        expect(Object.keys(response.json())).toEqual(['error'])
        expect(response.json().error.code).toBe('rate_limited')
      }
    } finally {
      await limited.close()
    }
  })
})

describe('auth rate limit', () => {
  it('is looser than register, so a typo is not a lockout', async () => {
    expect(env.RATE_LIMIT_AUTH_MAX).toBeGreaterThan(env.RATE_LIMIT_REGISTER_MAX)

    const limited = await freshApp()
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: `ghost-${Math.random()}@example.com`, password: PASSWORD },
        })

      for (let i = 0; i < env.RATE_LIMIT_AUTH_MAX; i += 1) {
        const response = await attempt()
        expect(response.statusCode, `request ${i + 1} should be allowed`).toBe(401)
      }

      expect((await attempt()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})
