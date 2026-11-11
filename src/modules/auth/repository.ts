import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../plugins/db.js'
import { apiKeys, users, type ApiKey, type User } from '../../db/schema.js'

export async function findUserByEmail(db: Database, email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  return user
}

export async function findUserById(db: Database, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return user
}

/**
 * Resolves a key hash to its owner in one query, with the revocation check in
 * the same statement: a revoked key costs the same single index seek as a live
 * one, and there is no window between "fetch the key" and "check if revoked".
 */
export async function findUserByKeyHash(db: Database, keyHash: string): Promise<User | undefined> {
  const [row] = await db
    .select({ user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1)

  return row?.user
}

export async function insertUser(
  db: Database,
  values: { email: string; passwordHash: string },
): Promise<User> {
  const [user] = await db.insert(users).values(values).returning()
  return user!
}

export async function insertApiKey(
  db: Database,
  values: { userId: string; name: string; keyPrefix: string; keyHash: string },
): Promise<{ id: string; createdAt: Date }> {
  const [key] = await db
    .insert(apiKeys)
    .values(values)
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt })

  return key!
}

export async function listApiKeys(db: Database, userId: string): Promise<ApiKey[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt))
}

/** Revokes one of the user's keys. Zero rows means it was not theirs to revoke. */
export async function revokeApiKey(db: Database, userId: string, keyId: string): Promise<number> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id })

  return revoked.length
}

/**
 * Fire and forget: `last_used_at` is bookkeeping, so it must not delay the
 * response. Failing to write it costs a stale timestamp and nothing else.
 */
export function touchApiKeyUsage(db: Database, keyHash: string): void {
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.keyHash, keyHash))
    .catch(() => {})
}