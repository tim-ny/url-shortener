import { Redis } from 'ioredis'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'

declare module 'fastify' {
  interface FastifyInstance {
    cache: Redis
  }
}

export async function registerCache(app: FastifyInstance): Promise<void> {
  const cache = new Redis(env.REDIS_URL, {
    lazyConnect: true,

    // Never let a command sit in a retry queue waiting for an unreachable
    // Redis: with these defaults a request would hang instead of falling back
    // to Postgres.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,

    connectTimeout: 5_000,
    commandTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  })

  cache.on('error', (err: Error) => {
    app.log.error({ err: err.message }, 'redis client error')
  })

  app.decorate('cache', cache)

  // Connect before serving traffic. Failing here is survivable: ioredis keeps
  // retrying in the background and the app runs slower, from Postgres alone.
  try {
    await cache.connect()
  } catch (err) {
    app.log.error({ err }, 'redis unreachable at boot; starting in degraded mode')
  }

  app.addHook('onClose', async () => {
    try {
      await cache.quit()
    } catch {
      cache.disconnect()
    }
  })
}