import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { links } from '../../db/schema.js'
import { hashApiKey, isWellFormedApiKey } from './key-generator.js'
import { findUserByKeyHash, touchApiKeyUsage } from './repository.js'
import { isPlan, type Plan } from '../../config/plans.js'
import { notFound, unauthorized } from '../../lib/errors.js'

export interface Principal {
  userId: string
  email: string
  plan: Plan
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

const BEARER_PREFIX = /^Bearer\s+/i

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null

  const match = BEARER_PREFIX.exec(header)
  if (!match) return null

  const token = header.slice(match[0].length).trim()
  return token.length > 0 ? token : null
}

export async function resolvePrincipal(
  request: FastifyRequest,
  rawKey: string | null,
): Promise<Principal | null> {
  if (rawKey === null || !isWellFormedApiKey(rawKey)) return null

  const keyHash = hashApiKey(rawKey)
  const user = await findUserByKeyHash(request.server.db, keyHash)
  if (!user) return null

  touchApiKeyUsage(request.server.db, keyHash)

  return {
    userId: user.id,
    email: user.email,
    plan: isPlan(user.plan) ? user.plan : 'free',
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const principal = await resolvePrincipal(request, extractBearerToken(request))

  if (!principal) {
    void reply.header('WWW-Authenticate', 'Bearer realm="url-shortener"')
    throw unauthorized()
  }

  request.principal = principal
}

export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const principal = await resolvePrincipal(request, extractBearerToken(request))
  if (principal) request.principal = principal
}

export async function requireOwner(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.principal) {
    throw unauthorized()
  }

  const { code } = request.params as { code: string }

  const row = await request.server.db
    .select({ ownerId: links.ownerId })
    .from(links)
    .where(eq(links.code, code))
    .limit(1)
    .then((rows) => rows[0])

  if (!row || row.ownerId !== request.principal.userId) {
    throw notFound()
  }
}
