import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  KEY_PREFIX_LIVE,
  KEY_PREFIX_TEST,
} from '../../src/modules/auth/key-generator.js'

const SECRET = 'a-test-pepper-that-is-long-enough-to-be-realistic'

describe('generateApiKey', () => {
  it('issues live keys in production and test keys everywhere else', () => {
    expect(generateApiKey('production').raw.startsWith(KEY_PREFIX_LIVE)).toBe(true)
    expect(generateApiKey('test').raw.startsWith(KEY_PREFIX_TEST)).toBe(true)
    expect(generateApiKey('development').raw.startsWith(KEY_PREFIX_TEST)).toBe(true)
  })

  it('produces a well-formed key with at least 256 bits of entropy', () => {
    const key = generateApiKey('test')

    expect(isWellFormedApiKey(key.raw)).toBe(true)
    // 43 base64url characters over 32 random bytes.
    expect(key.raw.slice(KEY_PREFIX_TEST.length)).toHaveLength(43)
  })

  it('never repeats across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5_000; i += 1) seen.add(generateApiKey('test').raw)
    expect(seen.size).toBe(5_000)
  })

  it('exposes only a short display prefix, never the full key', () => {
    const key = generateApiKey('test')

    expect(key.displayPrefix).toBe(key.raw.slice(0, KEY_PREFIX_TEST.length + 4))
    expect(key.displayPrefix.length).toBeLessThan(key.raw.length)
  })
})

describe('hashApiKey', () => {
  it('is a keyed HMAC, so a different pepper gives a different hash', () => {
    const key = generateApiKey('test').raw

    expect(hashApiKey(key, SECRET)).not.toBe(hashApiKey(key, 'a-different-pepper-value-here'))
  })

  it('is deterministic for the same key and pepper', () => {
    const key = generateApiKey('test').raw
    expect(hashApiKey(key, SECRET)).toBe(hashApiKey(key, SECRET))
  })

  it('matches an independent HMAC-SHA-256 of the same input', () => {
    const key = `usk_test_${'a'.repeat(43)}`

    expect(hashApiKey(key, SECRET)).toBe(
      createHmac('sha256', SECRET).update(key, 'utf8').digest('hex'),
    )
  })

  it('produces 64 hex chars, so it fits the key_hash column', () => {
    const hash = hashApiKey(generateApiKey('test').raw, SECRET)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiKey(generateApiKey('test').raw, SECRET)).not.toBe(hash)
  })
})

describe('isWellFormedApiKey', () => {
  it('rejects malformed keys before they reach the database', () => {
    expect(isWellFormedApiKey('')).toBe(false)
    expect(isWellFormedApiKey('not-a-key')).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(42)}`)).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(44)}`)).toBe(false)
    expect(isWellFormedApiKey(`ust_test_${'a'.repeat(43)}`)).toBe(false)
    // `+` and `/` are base64, not base64url.
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(42)}+`)).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(42)}/`)).toBe(false)
  })

  it('accepts either prefix regardless of environment', () => {
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(43)}`)).toBe(true)
    expect(isWellFormedApiKey(`usk_live_${'a'.repeat(43)}`)).toBe(true)
  })
})