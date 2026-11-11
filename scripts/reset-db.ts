import { Client } from 'pg'
import { assertDevDatabase, DATABASE_NAME } from './config.js'

const full = process.argv.includes('--full')

assertDevDatabase(full ? 'drop every schema in' : 'truncate tables in')

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

try {
  if (full) {
    // Both schemas: dropping only `public` leaves Drizzle's ledger intact, so
    // `db:migrate` then reports success and creates nothing.
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
    console.log(`Dropped all schemas in ${DATABASE_NAME}. Run 'npm run db:migrate' next.`)
  } else {
    const { rows } = await client.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
    )

    if (rows.length === 0) {
      const ledger = await client
        .query<{ count: string }>('SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations')
        .catch(() => ({ rows: [{ count: '0' }] }))

      if (Number(ledger.rows[0]!.count) > 0) {
        console.log(
          `No tables in ${DATABASE_NAME}, but Drizzle's ledger records applied migrations.\n` +
            'A plain migrate will now do nothing. Use `npm run db:reset:full`.',
        )
      } else {
        console.log(`No tables in ${DATABASE_NAME}; run 'npm run db:migrate' first.`)
      }
    } else {
      const list = rows.map((row) => `"${row.tablename.replace(/"/g, '""')}"`).join(', ')
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
      console.log(`Truncated ${rows.length} table(s) in ${DATABASE_NAME}.`)
    }
  }
} finally {
  await client.end()
}