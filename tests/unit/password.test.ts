import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js'
import { env } from '../../src/config/env.js'

describe('hashPassword', () => {
  it('produces an argon2id PHC string with the configured cost', async () => {
    const hash = await hashPassword('correct horse battery staple')

    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(hash).toContain(`m=${env.ARGON2_MEMORY_KIB}`)
    expect(hash).toContain(`t=${env.ARGON2_TIME_COST}`)
    expect(hash).toContain(`p=${env.ARGON2_PARALLELISM}`)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery staple')
    const b = await hashPassword('correct horse battery staple')

    expect(a).not.toBe(b)
    expect(a).not.toContain('correct horse')
  })
})

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('swordfish-1234')

    expect(await verifyPassword(hash, 'swordfish-1234')).toBe(true)
    expect(await verifyPassword(hash, 'swordfish-1235')).toBe(false)
    expect(await verifyPassword(hash, '')).toBe(false)
  })

  it('returns false for a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false)
  })
})