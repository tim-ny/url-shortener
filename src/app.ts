import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import pino from 'pino'
import helmet from '@fastify/helmet'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'node:crypto'
import { env } from './config/env.js'
import { registerDb } from './plugins/db.js'
import { registerCache } from './plugins/cache.js'
import { registerErrors } from './plugins/errors.js'
import { registerHealth } from './modules/health/routes.js'
import { registerAuthRoutes } from './modules/auth/routes.js'

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

const SYSTEM_PATHS = new Set(['livez', 'readyz', 'metrics', 'favicon.ico', 'robots.txt'])

function isRedirectRequest(request: { method: string; url: string }): boolean {
  if (request.method !== 'GET') return false
  if (!request.url?.startsWith('/')) return false
  if (request.url.startsWith('/v1/')) return false

  const segment = request.url.slice(1).split(/[/?#]/)[0] ?? ''
  return segment.length > 0 && !SYSTEM_PATHS.has(segment)
}

function buildLoggerOptions(): pino.LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  }
}

export interface BuildAppOptions {
  logDestination?: NodeJS.WritableStream

  rateLimitOverrides?: Partial<Record<'register' | 'auth', number>>
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const loggerOptions = buildLoggerOptions()

  const usePretty =
    !options.logDestination && env.NODE_ENV === 'development' && loggerOptions.level !== 'silent'

  const loggerInstance: FastifyBaseLogger | undefined = options.logDestination
    ? pino(loggerOptions, options.logDestination)
    : undefined

  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },

    logController: new LogController({
      disableRequestLogging: isRedirectRequest,
      requestIdLogLabel: 'reqId',
    }),

    ...(loggerInstance
      ? { loggerInstance }
      : {
          logger: {
            ...loggerOptions,
            transport: usePretty
              ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
              : undefined,
          },
        }),

    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID()
    },
  })

  registerErrors(app)

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(sensible)

  registerDb(app)
  await registerCache(app)

  await app.register(rateLimit, {
    global: false,
    max: env.RATE_LIMIT_REDIRECT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: (req) => req.ip,

    redis: app.cache,
    nameSpace: 'shortener:rl:',

    skipOnError: true,
  })

  registerHealth(app)
  registerAuthRoutes(app, { rateLimitOverrides: options.rateLimitOverrides })

  return app
}
