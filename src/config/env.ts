import { loadEnvFile } from 'node:process'
import { z } from 'zod'

/** Placeholder shipped in .env.example. Production refuses to start with it. */
export const DEV_SECRET = 'dev-only-insecure-secret-change-me-before-deploying-anything-real'

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

const envSchema = z
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

    RATE_LIMIT_WINDOW: int(1000, 3_600_000).default(60_000),
    RATE_LIMIT_MAX: int(1, 1_000_000).default(120),
    RATE_LIMIT_REGISTER_MAX: int(1, 1000).default(3),
    RATE_LIMIT_LOGIN_MAX: int(1, 1000).default(10),

    ARGON2_MEMORY_KIB: int(8, 1_048_576).default(19_456),
    ARGON2_TIME_COST: int(1, 16).default(2),
    ARGON2_PARALLELISM: int(1, 16).default(1),

    PASSWORD_MIN_LENGTH: int(8, 128).default(12),
    PASSWORD_MAX_LENGTH: int(32, 1024).default(200),
  })
  .superRefine((value, ctx) => {
    // Only production gets the extra rules: a copy-pasted development .env is
    // the realistic way to weaken one of these by accident.
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

/** Parses an environment, throwing one readable error listing every problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source)

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        'See .env.example for the supported variables.',
    )
  }

  return result.data
}

// Importing this module validates the environment, so a misconfigured server
// fails to boot instead of serving traffic with a placeholder APP_SECRET.
try {
  loadEnvFile('.env')
} catch {
  // No .env file: real environment variables are enough (Docker, CI, production).
}

export const env: Env = loadEnv()