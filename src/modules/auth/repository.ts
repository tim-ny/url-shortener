import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../plugins/db.js'
import { apiKeys, users, type User } from '../../db/schema.js'
import { env } from '../../config/env.js'

export function findUserByEmail(db: Database, email: string): Promise<User | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .then((rows) => rows[0])
}

export function findUserById(db: Database, id: string): Promise<User | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .then((rows) => rows[0])
}

export function insertUser(
  db: Database,
  values: { email: string; passwordHash: string },
): Promise<User> {
  return db
    .insert(users)
    .values({ ...values, plan: env.DEFAULT_PLAN })
    .returning()
    .then((rows) => rows[0]!)
}

export function insertApiKey(
  db: Database,
  values: {
    userId: string
    name: string
    keyPrefix: string
    keyHash: string
  },
): Promise<{ id: string; createdAt: Date }> {
  return db
    .insert(apiKeys)
    .values(values)
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt })
    .then((rows) => rows[0]!)
}

export function findUserByKeyHash(db: Database, keyHash: string): Promise<User | undefined> {
  return db
    .select({ user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1)
    .then((rows) => rows[0]?.user)
}

export function listApiKeys(
  db: Database,
  userId: string,
): Promise<
  {
    id: string
    name: string
    keyPrefix: string
    createdAt: Date
    lastUsedAt: Date | null
    revokedAt: Date | null
  }[]
> {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(sql`${apiKeys.createdAt} desc`)
}

export function revokeApiKey(db: Database, userId: string, keyId: string): Promise<number> {
  return db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id })
    .then((rows) => rows.length)
}

export function touchApiKeyUsage(db: Database, keyHash: string): void {
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.keyHash, keyHash))
    .catch(() => {})
}
