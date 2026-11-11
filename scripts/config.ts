import { loadEnvFile } from 'node:process'

try {
  loadEnvFile('.env')
} catch {
  // No .env file: real environment variables are enough.
}

const url = process.env.DATABASE_URL

if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

export const DATABASE_NAME = (() => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
})()

/** The databases docker-compose creates for this project. */
const LOCAL_DEV_NAMES = new Set(['shortener'])

/**
 * These scripts drop tables or write accounts with published passwords, so they
 * refuse anything that does not look like development or test data. Pass
 * --force if you are sure.
 */
export function assertDevDatabase(action: string): void {
  const looksSafe =
    LOCAL_DEV_NAMES.has(DATABASE_NAME) || /(^|[-_])(dev|test)([-_]|$)/i.test(DATABASE_NAME)

  if (!looksSafe && !process.argv.includes('--force')) {
    console.error(
      `Refusing to ${action} database "${DATABASE_NAME}".\n` +
        'Its name does not contain "dev" or "test", which usually means this points at real data.\n' +
        'Set DATABASE_URL to a development database, or re-run with --force if you are sure.',
    )
    process.exit(1)
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(`Refusing to ${action} a database while NODE_ENV=production.`)
    process.exit(1)
  }
}