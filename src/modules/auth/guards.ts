import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '../../plugins/db.js'
import { links, type Plan, type User } from '../../db/schema.js'
import { notFound, unauthorized } from '../../lib/errors.js'
import { hashApiKey, isWellFormedApiKey } from './key-generator.js'
import { findUserByKeyHash, touchApiKeyUsage } from './repository.js'

/** The authenticated caller, attached to the request by `authenticate`. */
export interface Principal {
  userId: string
  plan: Plan
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

/** Reads the token from `Authorization: Bearer <key>`. */
export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null

  return /^Bearer\s+(\S+)/i.exec(header)?.[1] ?? null
}

interface Caller {
  user: User
  keyHash: string
}

async function findCaller(db: Database, token: string | null): Promise<Caller | null> {
  if (token === null || !isWellFormedApiKey(token)) return null

  const keyHash = hashApiKey(token)
  const user = await findUserByKeyHash(db, keyHash)

  return user ? { user, keyHash } : null
}

/**
 * Rejects the request unless it carries a live API key. Applied per route rather
 * than globally, so routes that need no auth pay nothing for it.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const caller = await findCaller(request.server.db, extractBearerToken(request))

  if (!caller) {
    void reply.header('WWW-Authenticate', 'Bearer realm="url-shortener"')
    throw unauthorized()
  }

  request.principal = { userId: caller.user.id, plan: caller.user.plan }
  touchApiKeyUsage(request.server.db, caller.keyHash)
}

/**
 * 404, never 403, when the caller does not own `:code`. A 403 would confirm the
 * code is real and turn the API into an oracle for other people's links.
 */
export async function requireOwner(request: FastifyRequest): Promise<void> {
  if (!request.principal) throw unauthorized()

  const { code } = request.params as { code: string }

  const [link] = await request.server.db
    .select({ ownerId: links.ownerId })
    .from(links)
    .where(eq(links.code, code))
    .limit(1)

  // A null owner_id is an anonymous link: owned by nobody, including whoever
  // created it before they deleted their account.
  if (link?.ownerId !== request.principal.userId) throw notFound()
}