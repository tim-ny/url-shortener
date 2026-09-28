import { loadEnvFile } from 'node:process'

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

const DEV_DATABASE_NAMES = new Set(['shortener'])
const looksSafe =
  DEV_DATABASE_NAMES.has(databaseName) || /(^|[-_])(dev|test)([-_]|$)/i.test(databaseName)
const forced = process.argv.includes('--force')

if (!looksSafe && !forced) {
  console.error(
    `Refusing to seed database "${databaseName}".\n` +
      'These accounts have published passwords and are not safe outside development.\n' +
      'Set DATABASE_URL to a development database, or re-run with --force if you are sure.',
  )
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed while NODE_ENV=production.')
  process.exit(1)
}

const KEY_NAME = 'seed'
const PASSWORD = process.env.SEED_PASSWORD ?? 'seed-password-change-me'

const SEED_USERS = [
  { email: 'free@example.test', plan: 'free', password: `${PASSWORD}-free` },
  { email: 'pro@example.test', plan: 'pro', password: `${PASSWORD}-pro` },
] as const

const { env } = await import('../src/config/env.js')
const { hashPassword } = await import('../src/modules/auth/password.js')
const { generateApiKey } = await import('../src/modules/auth/key-generator.js')
const { drizzle } = await import('drizzle-orm/node-postgres')
const { Pool } = await import('pg')
const { apiKeys, users } = await import('../src/db/schema.js')
const { and, eq } = await import('drizzle-orm')

const pool = new Pool({ connectionString: url, max: 1 })
const db = drizzle(pool)

try {
  for (const seed of SEED_USERS) {
    const passwordHash = await hashPassword(seed.password)

    const user = await db
      .insert(users)
      .values({ email: seed.email, passwordHash, plan: seed.plan })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, plan: seed.plan },
      })
      .returning()
      .then((rows) => rows[0]!)

    await db.delete(apiKeys).where(and(eq(apiKeys.userId, user.id), eq(apiKeys.name, KEY_NAME)))

    const generated = generateApiKey()
    await db.insert(apiKeys).values({
      userId: user.id,
      name: KEY_NAME,
      keyPrefix: generated.displayPrefix,
      keyHash: generated.hash,
    })

    console.log(`${seed.plan.padEnd(4)}  ${seed.email}  ${seed.password}`)
    console.log(`     key: ${generated.raw}`)
  }

  console.log(`\nSeeded ${SEED_USERS.length} user(s) in ${databaseName}.`)
  console.log(`Keys are stored hashed and cannot be recovered; re-run to issue new ones.`)
  console.log(`Use: curl -H 'Authorization: Bearer <key>' http://localhost:${env.PORT}/v1/auth/me`)
} finally {
  await pool.end()
}
