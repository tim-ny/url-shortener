import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

const PROBE_TIMEOUT_MS = 2_000

/** Runs a check and reports the failure instead of hanging the endpoint. */
async function probe(check: () => Promise<unknown>): Promise<Error | null> {
  let timer: NodeJS.Timeout | undefined

  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS)
        timer.unref()
      }),
    ])
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

export function registerHealth(app: FastifyInstance): void {
  // Liveness checks nothing. If it depended on Postgres or Redis, one blip
  // would make the orchestrator restart every instance at once.
  app.get('/livez', { config: { rateLimit: false } }, () => ({ status: 'alive' as const }))

  // Readiness fails only on Postgres. Redis down reports "degraded" with a 200,
  // because the app falls back to Postgres and can still serve, just slower.
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    const [dbError, redisError] = await Promise.all([
      probe(() => app.db.execute(sql`select 1`)),
      probe(() => app.cache.ping()),
    ])

    if (dbError) app.log.error({ err: dbError.message }, 'readiness: postgres unreachable')
    if (redisError) app.log.warn({ err: redisError.message }, 'readiness: redis unreachable')

    return reply.code(dbError ? 503 : 200).send({
      status: dbError ? 'not_ready' : redisError ? 'degraded' : 'ok',
      checks: {
        postgres: dbError ? 'down' : 'up',
        redis: redisError ? 'down' : 'up',
      },
    })
  })
}