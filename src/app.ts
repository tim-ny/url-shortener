import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from 'fastify'
import type { LoggerOptions } from 'pino'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { env } from './config/env.js'
import { registerDb } from './plugins/db.js'
import { registerCache } from './plugins/cache.js'
import { registerErrors } from './plugins/errors.js'
import { registerHealth } from './modules/health/routes.js'
import { registerAuthRoutes } from './modules/auth/routes.js'

export interface BuildAppOptions {
  /** Test seam: collect log output in a stream instead of stdout. */
  logSink?: NodeJS.WritableStream
  /** Test seam: raise the request budgets so a test suite cannot throttle itself. */
  rateLimits?: Partial<Record<'default' | 'register' | 'login', number>>
}

/** Fastify's logger options plus the pino options it forwards. */
type LoggerConfig = FastifyLoggerOptions & LoggerOptions

function buildLogger(sink: NodeJS.WritableStream | undefined): LoggerConfig {
  const logger: LoggerConfig = {
    level: env.LOG_LEVEL,
    // Fastify's own `req` serializer logs method and url only, so request
    // headers never reach the log at all. These paths cover the case it misses:
    // code that logs `request.headers` itself.
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

  if (sink) {
    logger.stream = sink
  } else if (env.NODE_ENV === 'development' && env.LOG_LEVEL !== 'silent') {
    logger.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l' },
    }
  }

  return logger
}

/**
 * Builds the app without listening, so tests can drive it with `inject()`.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLogger(options.logSink),

    // Fastify sets ajv's `removeAdditional: true`, which deletes unknown body
    // properties instead of rejecting them. On a credential endpoint that turns
    // a typo like `passwrod` into "invalid credentials" forever.
    ajv: { customOptions: { removeAdditional: false } },
  })

  registerErrors(app)
  await app.register(helmet, { contentSecurityPolicy: false })

  registerDb(app)
  await registerCache(app)

  // Redis-backed, so the budget is shared by every instance behind a load
  // balancer. skipOnError: a Redis outage should cost throughput, not
  // availability — failing closed would let anyone take the service down by
  // taking Redis down.
  await app.register(rateLimit, {
    max: options.rateLimits?.default ?? env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    redis: app.cache,
    nameSpace: 'shortener:rl:',
    skipOnError: true,
  })

  registerHealth(app)
  registerAuthRoutes(app, {
    registerMax: options.rateLimits?.register ?? env.RATE_LIMIT_REGISTER_MAX,
    loginMax: options.rateLimits?.login ?? env.RATE_LIMIT_LOGIN_MAX,
  })

  return app
}