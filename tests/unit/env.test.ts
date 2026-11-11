import { describe, expect, it } from 'vitest'
import { DEV_SECRET, loadEnv } from '../../src/config/env.js'

const valid = {
  DATABASE_URL: 'postgres://localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(48),
}

describe('loadEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = loadEnv(valid)

    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3000)
    expect(env.RATE_LIMIT_MAX).toBe(120)
  })

  it('coerces numeric strings', () => {
    const env = loadEnv({ ...valid, PORT: '8080', DATABASE_POOL_MAX: '25' })

    expect(env.PORT).toBe(8080)
    expect(env.DATABASE_POOL_MAX).toBe(25)
  })

  it.each(['DATABASE_URL', 'REDIS_URL', 'APP_SECRET'])('rejects a missing %s', (key) => {
    expect(() => loadEnv({ ...valid, [key]: undefined })).toThrow()
  })

  it('rejects a short APP_SECRET', () => {
    expect(() => loadEnv({ ...valid, APP_SECRET: 'too-short' })).toThrow(/at least 32/)
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv({ ...valid, PORT: 'not-a-port' })).toThrow()
  })

  it('rejects an out-of-range PORT', () => {
    expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow()
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging' })).toThrow()
  })

  it('lists every problem at once rather than one per restart', () => {
    let message = ''
    try {
      loadEnv({})
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
    expect(message).toContain('APP_SECRET')
  })
})

describe('in production', () => {
  it('rejects the development placeholder secret', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', APP_SECRET: DEV_SECRET })).toThrow(
      /development placeholder/,
    )
  })

  it.each(['debug', 'trace'])('rejects LOG_LEVEL=%s', (level) => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', LOG_LEVEL: level })).toThrow(
      /production/,
    )
  })

  it('refuses to boot with weakened argon2', () => {
    const production = { ...valid, NODE_ENV: 'production' }

    expect(() => loadEnv({ ...production, ARGON2_MEMORY_KIB: '8192' })).toThrow(/OWASP baseline/)
    expect(() => loadEnv({ ...production, ARGON2_TIME_COST: '1' })).toThrow(/OWASP baseline/)
  })

  it('refuses a password minimum below the NIST floor', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', PASSWORD_MIN_LENGTH: '6' })).toThrow(
      /NIST/,
    )
  })

  it('accepts a real secret at info level', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).not.toThrow()
  })

  it('allows the placeholder secret outside production', () => {
    expect(() =>
      loadEnv({ ...valid, NODE_ENV: 'development', APP_SECRET: DEV_SECRET }),
    ).not.toThrow()
  })

  it('allows weaker argon2 outside production, for constrained hardware', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'development',
        ARGON2_MEMORY_KIB: '8192',
        ARGON2_TIME_COST: '1',
      }),
    ).not.toThrow()
  })
})

describe('defaults worth pinning', () => {
  it('defaults argon2 to the OWASP baseline', () => {
    const env = loadEnv(valid)

    expect(env.ARGON2_MEMORY_KIB).toBe(19_456)
    expect(env.ARGON2_TIME_COST).toBe(2)
    expect(env.ARGON2_PARALLELISM).toBe(1)
  })

  it('keeps the register budget tight and login looser, so a typo is not a lockout', () => {
    const env = loadEnv(valid)

    expect(env.RATE_LIMIT_REGISTER_MAX).toBe(3)
    expect(env.RATE_LIMIT_LOGIN_MAX).toBe(10)
    expect(env.RATE_LIMIT_LOGIN_MAX).toBeGreaterThan(env.RATE_LIMIT_REGISTER_MAX)
  })

  it('caps the password maximum, so argon2 cannot be used as a CPU-burn primitive', () => {
    const env = loadEnv(valid)

    expect(env.PASSWORD_MAX_LENGTH).toBeLessThanOrEqual(1024)
    expect(env.PASSWORD_MAX_LENGTH).toBeGreaterThanOrEqual(env.PASSWORD_MIN_LENGTH)
  })
})