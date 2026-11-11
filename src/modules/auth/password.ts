import { hash, verify } from '@node-rs/argon2'
import { env } from '../../config/env.js'

// argon2id 2 is the OWASP baseline (m=19456 KiB, t=2, p=1). Production refuses
// to boot below it; see src/config/env.ts.
const ARGON2ID = 2

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: env.ARGON2_MEMORY_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
} as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

/** Never throws: a corrupt stored hash is a failed login, not a 500. */
export function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  return verify(encodedHash, password, OPTIONS).catch(() => false)
}