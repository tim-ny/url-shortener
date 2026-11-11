import { Writable } from 'node:stream'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

/**
 * Rate-limit counters live in Redis under one key per IP, so they outlive both
 * `app.close()` and the test process. Every route shares a counter, which means
 * one test file could throttle the next, so the suite raises the budgets
 * everywhere except tests/integration/rate-limit.test.ts.
 */
export const NO_RATE_LIMITS = { default: 10_000, register: 10_000, login: 10_000 } as const

/** Integration tests run against shortener_test, never against development data. */
export async function truncateAll(app: FastifyInstance): Promise<void> {
  await app.db.execute(sql`TRUNCATE TABLE users, api_keys, links, clicks RESTART IDENTITY CASCADE`)
}

/** Collects log output so a test can assert on what did (not) reach it. */
export function captureLogs() {
  let text = ''

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk)
      callback()
    },
  })

  return {
    sink,
    /** Pino writes asynchronously, so let the stream drain before asserting. */
    async read(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return text
    },
    reset(): void {
      text = ''
    },
  }
}