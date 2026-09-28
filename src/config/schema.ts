import { z } from 'zod'

const csv = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

export const DEV_SECRET = 'dev-only-insecure-secret-change-me-before-deploying-anything-real'

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: int(1, 65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_POOL_MAX: int(1, 500).default(10),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),

    CODE_LENGTH: int(4, 12).default(7),

    CACHE_TTL_LINK: int(1, 2_592_000).default(86_400),
    CACHE_TTL_NEGATIVE: int(1, 3600).default(30),
    CACHE_TTL_CLICK_BUFFER: int(60, 604_800).default(172_800),

    RATE_LIMIT_WINDOW: int(1000, 3_600_000).default(60_000),
    RATE_LIMIT_CREATE_MAX: int(1, 100_000).default(20),
    RATE_LIMIT_REDIRECT_MAX: int(1, 1_000_000).default(120),
    RATE_LIMIT_REGISTER_MAX: int(1, 1000).default(3),
    RATE_LIMIT_AUTH_MAX: int(1, 1000).default(10),

    DEFAULT_PLAN: z.enum(['free', 'pro']).default('free'),

    ARGON2_MEMORY_KIB: int(8, 1_048_576).default(19_456),
    ARGON2_TIME_COST: int(1, 16).default(2),
    ARGON2_PARALLELISM: int(1, 16).default(1),

    PASSWORD_MIN_LENGTH: int(8, 128).default(12),
    PASSWORD_MAX_LENGTH: int(32, 1024).default(200),

    RESERVED_CODES: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return

    if (value.APP_SECRET === DEV_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_SECRET'],
        message:
          'APP_SECRET is still the development placeholder. Generate one: openssl rand -base64 48',
      })
    }
    if (value.LOG_LEVEL === 'trace' || value.LOG_LEVEL === 'debug') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_LEVEL'],
        message: `LOG_LEVEL=${value.LOG_LEVEL} in production will log request bodies and credential headers`,
      })
    }

    if (value.ARGON2_MEMORY_KIB < 19_456 || value.ARGON2_TIME_COST < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['ARGON2_MEMORY_KIB'],
        message:
          `Argon2 is below the OWASP baseline (m=${value.ARGON2_MEMORY_KIB} KiB, ` +
          `t=${value.ARGON2_TIME_COST}); production requires at least m=19456, t=2`,
      })
    }

    if (value.PASSWORD_MIN_LENGTH < 8) {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_MIN_LENGTH'],
        message: `PASSWORD_MIN_LENGTH=${value.PASSWORD_MIN_LENGTH} is below the NIST SP 800-63B minimum of 8`,
      })
    }
  })

export type Env = z.infer<typeof envSchema>

function format(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join('.') || '(root)'
      return `  - ${path}: ${issue.message}`
    })
    .join('\n')
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source)

  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${format(result.error.issues)}\n\n` +
        'See .env.example for the full set of supported variables.',
    )
  }

  return result.data
}

export const BASE_RESERVED_CODES: ReadonlySet<string> = new Set([
  'api',
  'v1',
  'health',
  'livez',
  'readyz',
  'metrics',
  'admin',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
  'docs',
  'swagger',
  'graphql',
  'login',
  'signup',
  'logout',
  'about',
  'terms',
  'privacy',
  'support',
  'help',
  'status',
  'www',
  'app',
  'dashboard',
  '_',
  '.well-known',
])

export function buildReservedCodes(extra?: string): ReadonlySet<string> {
  const codes = new Set(BASE_RESERVED_CODES)
  for (const code of extra ? csv(extra) : []) {
    codes.add(code.toLowerCase())
  }
  return codes
}
