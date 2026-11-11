import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { and, eq } from 'drizzle-orm'
import { apiKeys, users } from '../src/db/schema.js'
import { generateApiKey } from '../src/modules/auth/key-generator.js'
import { hashPassword } from '../src/modules/auth/password.js'
import { assertDevDatabase, DATABASE_NAME } from './config.js'

assertDevDatabase('seed')

const PORT = process.env.PORT ?? 3000
const KEY_NAME = 'seed'
const PASSWORD = process.env.SEED_PASSWORD ?? 'seed-password-change-me'

const SEED_USERS = [
  { email: 'free@example.test', plan: 'free' as const, password: `${PASSWORD}-free` },
  { email: 'pro@example.test', plan: 'pro' as const, password: `${PASSWORD}-pro` },
]

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const db = drizzle(pool)

try {
  for (const seed of SEED_USERS) {
    const passwordHash = await hashPassword(seed.password)

    const [user] = await db
      .insert(users)
      .values({ email: seed.email, passwordHash, plan: seed.plan })
      .onConflictDoUpdate({ target: users.email, set: { passwordHash, plan: seed.plan } })
      .returning()

    await db.delete(apiKeys).where(and(eq(apiKeys.userId, user!.id), eq(apiKeys.name, KEY_NAME)))

    const generated = generateApiKey()
    await db.insert(apiKeys).values({
      userId: user!.id,
      name: KEY_NAME,
      keyPrefix: generated.displayPrefix,
      keyHash: generated.hash,
    })

    console.log(`${seed.plan.padEnd(4)}  ${seed.email}  ${seed.password}`)
    console.log(`     key: ${generated.raw}`)
  }

  console.log(`\nSeeded ${SEED_USERS.length} user(s) in ${DATABASE_NAME}.`)
  console.log('Keys are stored hashed and cannot be recovered; re-run to issue new ones.')
  console.log(`Use: curl -H 'Authorization: Bearer <key>' http://localhost:${PORT}/v1/auth/me`)
} finally {
  await pool.end()
}