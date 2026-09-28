import type { FastifyInstance } from 'fastify'

const PROBE_TIMEOUT_MS = 2_000

async function withTimeout(label: string, check: () => Promise<void>): Promise<Error | null> {
  let timer: NodeJS.Timeout | undefined

  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out`)), PROBE_TIMEOUT_MS)
        timer.unref()
      }),
    ])
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type Readiness = 'ok' | 'degraded' | 'not_ready'

export function registerHealth(app: FastifyInstance): void {
  app.get('/livez', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.code(200).send({ status: 'alive' })
  })

  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    const [dbError, cacheError] = await Promise.all([
      withTimeout('postgres', app.pingDatabase),
      withTimeout('redis', app.pingCache),
    ])

    const status: Readiness = dbError ? 'not_ready' : cacheError ? 'degraded' : 'ok'

    if (dbError) app.log.error({ err: dbError.message }, 'readiness: postgres unreachable')
    if (cacheError) app.log.warn({ err: cacheError.message }, 'readiness: redis unreachable')

    return reply.code(dbError ? 503 : 200).send({
      status,
      checks: {
        postgres: dbError ? 'down' : 'up',
        redis: cacheError ? 'down' : 'up',
      },
    })
  })
}
