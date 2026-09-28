import { Redis } from 'ioredis'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'

export type Cache = Redis

declare module 'fastify' {
  interface FastifyInstance {
    cache: Cache
    pingCache: () => Promise<void>
  }
}

export async function registerCache(app: FastifyInstance): Promise<void> {
  const cache = new Redis(env.REDIS_URL, {
    lazyConnect: true,

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
  app.decorate('pingCache', async () => {
    await cache.ping()
  })

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
