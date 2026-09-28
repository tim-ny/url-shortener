import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const SECRET_BYTES = 32
const SECRET_CHARS = Math.ceil((SECRET_BYTES * Math.log(256)) / Math.log(62))

const REJECTION_LIMIT = 248

export const KEY_PREFIX_LIVE = 'usk_live_'
export const KEY_PREFIX_TEST = 'usk_test_'

const KEY_PATTERN = /^usk_(?:live|test)_[A-Za-z0-9]{43}$/

export function keyPrefixForEnvironment(nodeEnv: string = env.NODE_ENV): string {
  return nodeEnv === 'production' ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST
}

function randomBase62(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= REJECTION_LIMIT) continue
      out += BASE62[byte % BASE62.length]
      if (out.length === length) break
    }
  }
  return out
}

export interface GeneratedKey {
  raw: string
  displayPrefix: string
  hash: string
}

const DISPLAY_CHARS = 4

export function generateApiKey(nodeEnv: string = env.NODE_ENV): GeneratedKey {
  const prefix = keyPrefixForEnvironment(nodeEnv)
  const secret = randomBase62(SECRET_CHARS)

  return {
    raw: prefix + secret,
    displayPrefix: prefix + secret.slice(0, DISPLAY_CHARS),
    hash: hashApiKey(prefix + secret),
  }
}

export function hashApiKey(rawKey: string, secret: string = env.APP_SECRET): string {
  return createHmac('sha256', secret).update(rawKey, 'utf8').digest('hex')
}

export function isWellFormedApiKey(rawKey: string): boolean {
  return KEY_PATTERN.test(rawKey)
}

export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')

  if (bufferA.length !== bufferB.length) return false

  return timingSafeEqual(bufferA, bufferB)
}
