import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'
import * as schema from '../db/schema.js'

export type Database = NodePgDatabase<typeof schema>

declare module 'fastify' {
  interface FastifyInstance {
    db: Database
    pool: Pool
    pingDatabase: () => Promise<void>
  }
}

export function registerDb(app: FastifyInstance): void {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  })

  pool.on('error', (err) => {
    app.log.error({ err }, 'postgres pool client error')
  })

  const db = drizzle(pool, { schema })

  app.decorate('db', db)
  app.decorate('pool', pool)
  app.decorate('pingDatabase', async () => {
    await pool.query('SELECT 1')
  })

  app.addHook('onClose', async () => {
    await pool.end()
  })
}
