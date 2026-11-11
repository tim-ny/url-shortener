import { createHmac, randomBytes } from 'node:crypto'
import { env } from '../../config/env.js'

export const KEY_PREFIX_LIVE = 'usk_live_'
export const KEY_PREFIX_TEST = 'usk_test_'

// 32 random bytes, base64url-encoded: 43 characters carrying 256 bits.
const SECRET_BYTES = 32
const DISPLAY_CHARS = 4

const KEY_PATTERN = /^usk_(?:live|test)_[A-Za-z0-9_-]{43}$/

export interface GeneratedKey {
  /** Shown to the user once, at issue time. Never stored. */
  raw: string
  /** Safe to display and store: the prefix plus the first few characters. */
  displayPrefix: string
  /** What actually goes in the database. */
  hash: string
}

export function generateApiKey(nodeEnv: string = env.NODE_ENV): GeneratedKey {
  const prefix = nodeEnv === 'production' ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST
  const raw = prefix + randomBytes(SECRET_BYTES).toString('base64url')

  return {
    raw,
    displayPrefix: raw.slice(0, prefix.length + DISPLAY_CHARS),
    hash: hashApiKey(raw),
  }
}

/**
 * Keys are hashed with a keyed HMAC, not a password KDF. An API key has 256
 * bits of entropy, so there is no dictionary to slow down, and the pepper means a
 * stolen database dump on its own yields nothing usable. Decisively, an HMAC is
 * indexable: verifying a key is one index seek, where bcrypt or argon2 would
 * mean hashing every candidate row.
 */
export function hashApiKey(rawKey: string, secret: string = env.APP_SECRET): string {
  return createHmac('sha256', secret).update(rawKey, 'utf8').digest('hex')
}

/** Cheap shape check, so a malformed key never reaches the database. */
export function isWellFormedApiKey(rawKey: string): boolean {
  return KEY_PATTERN.test(rawKey)
}