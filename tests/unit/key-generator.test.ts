import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  keyPrefixForEnvironment,
  safeEqual,
  KEY_PREFIX_LIVE,
  KEY_PREFIX_TEST,
} from '../../src/modules/auth/key-generator.js'

const SECRET = 'a-test-pepper-that-is-long-enough-to-be-realistic'

describe('key prefixes', () => {
  it('issues live keys in production and test keys everywhere else', () => {
    expect(keyPrefixForEnvironment('production')).toBe(KEY_PREFIX_LIVE)
    expect(keyPrefixForEnvironment('test')).toBe(KEY_PREFIX_TEST)
    expect(keyPrefixForEnvironment('development')).toBe(KEY_PREFIX_TEST)
  })

  it('prefixes a generated key according to the environment', () => {
    expect(generateApiKey('production').raw.startsWith(KEY_PREFIX_LIVE)).toBe(true)
    expect(generateApiKey('test').raw.startsWith(KEY_PREFIX_TEST)).toBe(true)
  })
})

describe('generateApiKey', () => {
  it('produces a well-formed key', () => {
    const key = generateApiKey('test')
    expect(isWellFormedApiKey(key.raw)).toBe(true)
  })

  it('carries at least 256 bits of entropy', () => {
    const key = generateApiKey('test')
    const secret = key.raw.slice(KEY_PREFIX_TEST.length)

    expect(secret).toHaveLength(43)

    const bits = secret.length * Math.log2(62)
    expect(bits).toBeGreaterThanOrEqual(256)
  })

  it('never repeats across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5_000; i += 1) seen.add(generateApiKey('test').raw)
    expect(seen.size).toBe(5_000)
  })

  it('produces a uniform first character', () => {
    const counts = new Map<string, number>()
    const draws = 20_000

    for (let i = 0; i < draws; i += 1) {
      const first = generateApiKey('test').raw.at(KEY_PREFIX_TEST.length)!
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }

    expect(counts.size).toBe(62)

    const expected = draws / 62
    for (const [char, count] of counts) {
      expect(count, `character ${char}`).toBeGreaterThan(expected * 0.8)
      expect(count, `character ${char}`).toBeLessThan(expected * 1.2)
    }
  })

  it('exposes only a short display prefix, never the full key', () => {
    const key = generateApiKey('test')
    expect(key.displayPrefix).toBe(
      `${KEY_PREFIX_TEST}${key.raw.slice(KEY_PREFIX_TEST.length, KEY_PREFIX_TEST.length + 4)}`,
    )
    expect(key.displayPrefix.length).toBeLessThan(key.raw.length)
  })
})

describe('hashApiKey', () => {
  it('is a keyed HMAC, so a different pepper gives a different hash', () => {
    const key = generateApiKey('test').raw
    const a = hashApiKey(key, SECRET)
    const b = hashApiKey(key, 'a-completely-different-pepper-value-here')

    expect(a).not.toBe(b)
  })

  it('is deterministic for the same key and pepper', () => {
    const key = generateApiKey('test').raw
    expect(hashApiKey(key, SECRET)).toBe(hashApiKey(key, SECRET))
  })

  it('matches an independent HMAC-SHA-256 of the same input', () => {
    const key = 'usk_test_' + 'a'.repeat(43)
    expect(hashApiKey(key, SECRET)).toBe(
      createHmac('sha256', SECRET).update(key, 'utf8').digest('hex'),
    )
  })

  it('produces 64 hex chars, so it fits the char(64) column', () => {
    const hash = hashApiKey(generateApiKey('test').raw, SECRET)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes different keys to different hashes', () => {
    const a = hashApiKey(generateApiKey('test').raw, SECRET)
    const b = hashApiKey(generateApiKey('test').raw, SECRET)
    expect(a).not.toBe(b)
  })
})

describe('isWellFormedApiKey', () => {
  it('rejects malformed keys before they reach the database', () => {
    expect(isWellFormedApiKey('')).toBe(false)
    expect(isWellFormedApiKey('not-a-key')).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(42)}`)).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(44)}`)).toBe(false)
    expect(isWellFormedApiKey(`ust_test_${'a'.repeat(43)}`)).toBe(false)
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(42)}-`)).toBe(false)
  })

  it('accepts either prefix regardless of environment', () => {
    expect(isWellFormedApiKey(`usk_test_${'a'.repeat(43)}`)).toBe(true)
    expect(isWellFormedApiKey(`usk_live_${'a'.repeat(43)}`)).toBe(true)
  })
})

describe('safeEqual', () => {
  it('compares equal and unequal values correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false rather than throwing on a length mismatch', () => {
    expect(() => safeEqual('short', 'much longer value')).not.toThrow()
    expect(safeEqual('short', 'much longer value')).toBe(false)
  })
})
