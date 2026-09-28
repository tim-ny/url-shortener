import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../../src/modules/auth/password.js'
import { env } from '../../src/config/env.js'

describe('hashPassword', () => {
  it('produces an argon2id PHC string', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('$argon2id$')).toBe(true)
  })

  it('uses the configured cost parameters', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toContain(`m=${env.ARGON2_MEMORY_KIB}`)
    expect(hash).toContain(`t=${env.ARGON2_TIME_COST}`)
    expect(hash).toContain(`p=${env.ARGON2_PARALLELISM}`)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery staple')
    const b = await hashPassword('correct horse battery staple')
    expect(a).not.toBe(b)
  })

  it('never contains the plaintext', async () => {
    const password = 'correct horse battery staple'
    expect(await hashPassword(password)).not.toContain(password)
  })
})

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('swordfish-1234')
    expect(await verifyPassword(hash, 'swordfish-1234')).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('swordfish-1234')
    expect(await verifyPassword(hash, 'swordfish-1235')).toBe(false)
  })

  it('rejects an empty password against a real hash', async () => {
    const hash = await hashPassword('swordfish-1234')
    expect(await verifyPassword(hash, '')).toBe(false)
  })

  it('returns false for a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false)
  })
})

describe('verifyPasswordOrDummy', () => {
  it('returns false when there is no stored hash', async () => {
    expect(await verifyPasswordOrDummy(null, 'anything')).toBe(false)
  })

  it('verifies normally when there is one', async () => {
    const hash = await hashPassword('swordfish-1234')
    expect(await verifyPasswordOrDummy(hash, 'swordfish-1234')).toBe(true)
  })

  it('spends comparable time whether or not the account exists', async () => {
    const real = await hashPassword('swordfish-1234')

    const time = async (encoded: string | null) => {
      const start = process.hrtime.bigint()
      await verifyPasswordOrDummy(encoded, 'a-password-that-does-not-match')
      return Number(process.hrtime.bigint() - start) / 1e6
    }

    await time(real)

    const realTimes = [await time(real), await time(real), await time(real)]
    const dummyTimes = [await time(null), await time(null), await time(null)]

    const best = (xs: number[]) => Math.min(...xs)
    const ratio = best(dummyTimes) / best(realTimes)

    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(3)
  })
})
