import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { authenticate } from './guards.js'
import * as service from './service.js'
import { toPublicUser } from './service.js'
import { findUserById } from './repository.js'
import { notFound, unauthorized } from '../../lib/errors.js'

const emailSchema = {
  type: 'string',
  format: 'email',
  maxLength: 254,
} as const

const passwordSchema = {
  type: 'string',
  minLength: env.PASSWORD_MIN_LENGTH,
  maxLength: env.PASSWORD_MAX_LENGTH,
} as const

const keyNameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
} as const

const registerBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: emailSchema,
    password: passwordSchema,
    keyName: keyNameSchema,
  },
} as const

const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: emailSchema,
    password: passwordSchema,
    keyName: keyNameSchema,
  },
} as const

const userSchema = {
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
  },
} as const

const credentialsResponse = {
  200: {
    description: 'Authenticated. The API key is returned once and never again.',
    type: 'object',
    properties: {
      user: userSchema,
      apiKey: {
        ...issuedKeySchema,
        properties: {
          ...issuedKeySchema.properties,
          key: { type: 'string' },
        },
      },
    },
  },
  409: { description: 'Email already registered' },
  429: { description: 'Rate limited' },
} as const

const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const

export interface AuthRouteOptions {
  rateLimitOverrides?: Partial<Record<'register' | 'auth', number>>
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions = {}): void {
  const registerMax = options.rateLimitOverrides?.register ?? env.RATE_LIMIT_REGISTER_MAX
  const authMax = options.rateLimitOverrides?.auth ?? env.RATE_LIMIT_AUTH_MAX

  app.post<{ Body: { email: string; password: string; keyName?: string } }>(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: registerMax, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: {
        body: registerBody,
        response: credentialsResponse,
      },
    },
    async (request, reply) => {
      const result = await service.register(request.server.db, request.body)
      return reply.code(201).send(result)
    },
  )

  app.post<{ Body: { email: string; password: string; keyName?: string } }>(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: authMax, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: {
        body: loginBody,
        response: credentialsResponse,
      },
    },
    async (request, reply) => {
      const result = await service.login(request.server.db, request.body)
      return reply.code(200).send(result)
    },
  )

  app.get(
    '/v1/auth/me',
    {
      preHandler: authenticate,
      schema: {
        response: {
          200: { type: 'object', properties: { user: userSchema } },
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = await findUserById(request.server.db, request.principal!.userId)

      if (!user) {
        throw unauthorized()
      }

      return reply.send({ user: toPublicUser(user) })
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
                    id: { type: 'string' },
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
        },
      },
    },
    async (request, reply) => {
      const keys = await service.listKeys(request.server.db, request.principal!.userId)
      return reply.send({
        keys: keys.map((key) => ({
          id: key.id,
          name: key.name,
          prefix: key.keyPrefix,
          createdAt: key.createdAt.toISOString(),
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          revokedAt: key.revokedAt?.toISOString() ?? null,
        })),
      })
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
        request.principal!.userId,
        request.params.id,
      )

      if (!revoked) {
        throw notFound()
      }

      return reply.code(204).send()
    },
  )
}
