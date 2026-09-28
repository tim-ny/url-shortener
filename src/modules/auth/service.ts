import type { Database } from '../../plugins/db.js'
import { hashPassword, verifyPasswordOrDummy } from './password.js'
import { generateApiKey } from './key-generator.js'
import {
  findUserByEmail,
  insertApiKey,
  insertUser,
  listApiKeys,
  revokeApiKey,
} from './repository.js'
import { emailTaken, invalidCredentials, isUniqueViolation } from '../../lib/errors.js'
import type { Plan } from '../../config/plans.js'

export interface PublicUser {
  id: string
  email: string
  plan: Plan
  createdAt: string
}

export interface IssuedKey {
  key: string
  prefix: string
  id: string
  createdAt: string
}

export function toPublicUser(user: {
  id: string
  email: string
  plan: Plan
  createdAt: Date
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt.toISOString(),
  }
}

export interface RegisterInput {
  email: string
  password: string
  keyName?: string
}

export async function register(
  db: Database,
  input: RegisterInput,
): Promise<{ user: PublicUser; apiKey: IssuedKey }> {
  const email = input.email.trim().toLowerCase()
  const passwordHash = await hashPassword(input.password)

  let user
  try {
    user = await insertUser(db, { email, passwordHash })
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_idx')) {
      throw emailTaken()
    }
    throw err
  }

  const generated = generateApiKey()
  const key = await insertApiKey(db, {
    userId: user.id,
    name: input.keyName?.trim() || 'default',
    keyPrefix: generated.displayPrefix,
    keyHash: generated.hash,
  })

  return {
    user: toPublicUser(user),
    apiKey: {
      key: generated.raw,
      prefix: generated.displayPrefix,
      id: key.id,
      createdAt: key.createdAt.toISOString(),
    },
  }
}

export async function login(
  db: Database,
  input: { email: string; password: string; keyName?: string },
): Promise<{ user: PublicUser; apiKey: IssuedKey }> {
  const email = input.email.trim().toLowerCase()
  const user = await findUserByEmail(db, email)

  const ok = await verifyPasswordOrDummy(user?.passwordHash ?? null, input.password)

  if (!user || !ok) {
    throw invalidCredentials()
  }

  const generated = generateApiKey()
  const key = await insertApiKey(db, {
    userId: user.id,
    name: input.keyName?.trim() || 'default',
    keyPrefix: generated.displayPrefix,
    keyHash: generated.hash,
  })

  return {
    user: toPublicUser(user),
    apiKey: {
      key: generated.raw,
      prefix: generated.displayPrefix,
      id: key.id,
      createdAt: key.createdAt.toISOString(),
    },
  }
}

export async function revoke(db: Database, userId: string, keyId: string): Promise<boolean> {
  const affected = await revokeApiKey(db, userId, keyId)
  return affected > 0
}

export function listKeys(db: Database, userId: string) {
  return listApiKeys(db, userId)
}
