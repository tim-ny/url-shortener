import { loadEnvFile } from 'node:process'
import { Client } from 'pg'

try {
  loadEnvFile('.env')
} catch {}

const url = process.env.DATABASE_URL

if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
})()

const looksSafe = /(^|[-_])(dev|test)([-_]|$)/i.test(databaseName)
const forced = process.argv.includes('--force')

if (!looksSafe && !forced) {
  console.error(
    `Refusing to reset database "${databaseName}".\n` +
      'Its name does not contain "dev" or "test", which usually means this points at real data.\n' +
      'Set DATABASE_URL to a development database, or re-run with --force if you are sure.',
  )
  process.exit(1)
}

const client = new Client({ connectionString: url })
await client.connect()

try {
  if (process.argv.includes('--full')) {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
    console.log(`Dropped all schemas in ${databaseName}. Run 'npm run db:migrate' next.`)
  } else {
    const { rows } = await client.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
    )

    if (rows.length === 0) {
      const ledger = await client
        .query<{ count: string }>(
          'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
        )
        .catch(() => ({ rows: [{ count: '0' }] }))

      if (Number(ledger.rows[0]!.count) > 0) {
        console.log(
          `No tables in ${databaseName}, but Drizzle's ledger records applied migrations.\n` +
            'A plain migrate will now do nothing. Use `npm run db:reset:full`.',
        )
      } else {
        console.log(`No tables in ${databaseName}; run 'npm run db:migrate' first.`)
      }
    } else {
      const list = rows.map((row) => `"${row.tablename.replace(/"/g, '""')}"`).join(', ')
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
      console.log(`Truncated ${rows.length} table(s) in ${databaseName}.`)
    }
  }
} finally {
  await client.end()
}
