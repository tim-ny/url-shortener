import { hash, verify } from '@node-rs/argon2'
import { env } from '../../config/env.js'

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

export function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  return verify(encodedHash, password, OPTIONS).catch(() => false)
}

const DUMMY_HASH = await hashPassword('timing-equalisation-not-a-real-password')

export async function verifyPasswordOrDummy(
  encoded: string | null,
  password: string,
): Promise<boolean> {
  if (encoded === null) {
    await verifyPassword(DUMMY_HASH, password)
    return false
  }
  return verifyPassword(encoded, password)
}
