import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext'
  },
})

export const userPlan = pgEnum('user_plan', ['free', 'pro'])
export const linkState = pgEnum('link_state', ['active', 'disabled'])

export const CODE_MAX_LENGTH = 12

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable(
  'users',
  {
    id: id(),

    email: citext('email').notNull(),

    passwordHash: text('password_hash').notNull(),

    plan: userPlan('plan').notNull().default('free'),

    createdAt: createdAt(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
)

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 64 }).notNull(),

    keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),

    keyHash: varchar('key_hash', { length: 64 }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),

    index('api_keys_user_id_idx').on(table.userId),
  ],
)

export const links = pgTable(
  'links',
  {
    code: varchar('code', { length: CODE_MAX_LENGTH }).primaryKey(),

    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),

    targetUrl: text('target_url').notNull(),

    state: linkState('state').notNull().default('active'),

    isCustom: boolean('is_custom').notNull().default(false),

    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    index('links_owner_created_idx').on(table.ownerId, table.createdAt.desc()),

    index('links_expires_at_idx')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} is not null`),
  ],
)

export const clicks = pgTable(
  'clicks',
  {
    code: varchar('code', { length: CODE_MAX_LENGTH })
      .notNull()
      .references(() => links.code, { onDelete: 'cascade' }),

    bucket: timestamp('bucket', { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('hour', now())`),

    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  (table) => [uniqueIndex('clicks_code_bucket_idx').on(table.code, table.bucket)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
export type Link = typeof links.$inferSelect
export type NewLink = typeof links.$inferInsert
export type Click = typeof clicks.$inferSelect
export type NewClick = typeof clicks.$inferInsert

export const clicksOnConflictTarget = [clicks.code, clicks.bucket]
