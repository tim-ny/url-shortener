import type { Database } from '../../plugins/db.js'
import type { ApiKey, Plan, User } from '../../db/schema.js'
import { emailTaken, invalidCredentials, isUniqueViolation, unauthorized } from '../../lib/errors.js'
import { generateApiKey } from './key-generator.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  findUserByEmail,
  findUserById,
  insertApiKey,
  insertUser,
  listApiKeys,
  revokeApiKey,
} from './repository.js'

export interface Credentials {
  email: string
  password: string
  keyName?: string
}

export interface PublicUser {
  id: string
  email: string
  plan: Plan
  createdAt: string
}

export interface PublicKey {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** Returned once, at issue time. The raw key is never stored, so never again. */
export interface IssuedKey {
  id: string
  key: string
  prefix: string
  createdAt: string
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt.toISOString(),
  }
}

export function toPublicKey(key: ApiKey): PublicKey {
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  }
}

async function issueKey(db: Database, userId: string, keyName?: string): Promise<IssuedKey> {
  const generated = generateApiKey()

  const key = await insertApiKey(db, {
    userId,
    name: keyName?.trim() || 'default',
    keyPrefix: generated.displayPrefix,
    keyHash: generated.hash,
  })

  return {
    id: key.id,
    key: generated.raw,
    prefix: generated.displayPrefix,
    createdAt: key.createdAt.toISOString(),
  }
}

export async function register(
  db: Database,
  credentials: Credentials,
): Promise<{ user: PublicUser; apiKey: IssuedKey }> {
  // Hash first: never create an account whose password we cannot verify later.
  const passwordHash = await hashPassword(credentials.password)

  let user: User
  try {
    user = await insertUser(db, {
      email: credentials.email.trim().toLowerCase(),
      passwordHash,
    })
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_idx')) throw emailTaken()
    throw err
  }

  return { user: toPublicUser(user), apiKey: await issueKey(db, user.id, credentials.keyName) }
}

export async function login(
  db: Database,
  credentials: Credentials,
): Promise<{ user: PublicUser; apiKey: IssuedKey }> {
  const user = await findUserByEmail(db, credentials.email.trim().toLowerCase())

  // Spend the same argon2 work whether or not the account exists. Looking up an
  // unknown email returns in about a millisecond where a real verification takes
  // far longer, and that gap is a reliable account-enumeration oracle.
  let passwordMatches = false
  if (user) {
    passwordMatches = await verifyPassword(user.passwordHash, credentials.password)
  } else {
    await hashPassword(credentials.password)
  }

  if (!user || !passwordMatches) throw invalidCredentials()

  return { user: toPublicUser(user), apiKey: await issueKey(db, user.id, credentials.keyName) }
}

export async function me(db: Database, userId: string): Promise<PublicUser> {
  const user = await findUserById(db, userId)

  // The guard already resolved the key and its owner together, so this only
  // happens if the account was deleted between the two statements.
  if (!user) throw unauthorized()

  return toPublicUser(user)
}

export async function listKeys(db: Database, userId: string): Promise<PublicKey[]> {
  const keys = await listApiKeys(db, userId)
  return keys.map(toPublicKey)
}

/** False when the key id is not one of this user's keys, which the route turns into a 404. */
export async function revoke(db: Database, userId: string, keyId: string): Promise<boolean> {
  const revoked = await revokeApiKey(db, userId, keyId)
  return revoked > 0
}