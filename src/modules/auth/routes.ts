import type { FastifyInstance, FastifyRequest } from 'fastify'
import { env } from '../../config/env.js'
import { authenticate, type Principal } from './guards.js'
import * as service from './service.js'
import { notFound } from '../../lib/errors.js'

export interface AuthRouteOptions {
  /** Per-window budget for each auth route. Registration is the tighter one. */
  registerMax: number
  loginMax: number
}

const credentialsBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 254 },
    // The maximum is not a style choice: argon2's cost scales with input length,
    // so an unbounded password field is a free CPU-burn primitive.
    password: {
      type: 'string',
      minLength: env.PASSWORD_MIN_LENGTH,
      maxLength: env.PASSWORD_MAX_LENGTH,
    },
    keyName: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

const publicUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    plan: { type: 'string', enum: ['free', 'pro'] },
    createdAt: { type: 'string' },
  },
} as const

const issuedKeySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    prefix: { type: 'string' },
    createdAt: { type: 'string' },
    key: { type: 'string' },
  },
} as const

const credentialsResponse = {
  200: {
    description: 'Authenticated. The API key is returned once and never again.',
    type: 'object',
    properties: { user: publicUserSchema, apiKey: issuedKeySchema },
  },
  409: { description: 'Email already registered' },
  429: { description: 'Rate limited' },
} as const

const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const

/** `authenticate` has already run, so this only satisfies the type system. */
function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new Error('route reached without an authenticated principal')
  return request.principal
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  app.post<{ Body: service.Credentials }>(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: options.registerMax, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: { body: credentialsBody, response: credentialsResponse },
    },
    async (request, reply) => {
      const result = await service.register(request.server.db, request.body)
      return reply.code(201).send(result)
    },
  )

  app.post<{ Body: service.Credentials }>(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: options.loginMax, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: { body: credentialsBody, response: credentialsResponse },
    },
    async (request, reply) => {
      const result = await service.login(request.server.db, request.body)
      return reply.send(result)
    },
  )

  app.get(
    '/v1/auth/me',
    {
      preHandler: authenticate,
      schema: {
        response: {
          200: { type: 'object', properties: { user: publicUserSchema } },
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = await service.me(request.server.db, principalOf(request).userId)
      return reply.send({ user })
    },
  )

  app.get(
    '/v1/auth/keys',
    {
      preHandler: authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              keys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    prefix: { type: 'string' },
                    createdAt: { type: 'string' },
                    lastUsedAt: { type: ['string', 'null'] },
                    revokedAt: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const keys = await service.listKeys(request.server.db, principalOf(request).userId)
      return reply.send({ keys })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/auth/keys/:id',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Key revoked' },
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const revoked = await service.revoke(
        request.server.db,
        principalOf(request).userId,
        request.params.id,
      )

      // Another user's key id is a 404 too, never a 403: confirming it exists
      // would let anyone probe other accounts, and a 404 must not revoke it.
      if (!revoked) throw notFound()

      return reply.code(204).send()
    },
  )
}