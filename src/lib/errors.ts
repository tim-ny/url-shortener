/** Stable codes clients can branch on. `message` is for humans. */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'invalid_credentials'
  | 'email_taken'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'

/**
 * An error with an HTTP status and a code, thrown by services and rendered by the
 * error handler in src/plugins/errors.ts. Services throw these instead of
 * building responses, so they stay callable from a route or a test.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const unauthorized = (message = 'A valid API key is required.') =>
  new AppError('unauthorized', 401, message)

export const invalidCredentials = () =>
  new AppError('invalid_credentials', 401, 'Email or password is incorrect.')

export const emailTaken = () =>
  new AppError('email_taken', 409, 'An account with that email already exists.')

/**
 * The only way to produce a 404. Every 404 has the same body on purpose: an
 * unowned resource must be indistinguishable from one that never existed,
 * otherwise the API becomes an oracle for other people's links.
 */
export const notFound = () => new AppError('not_found', 404, 'Link not found.')

/** Postgres unique violation (SQLSTATE 23505), optionally for one constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  // Drizzle wraps driver errors, so the pg fields may sit in `cause`. The walk is
  // bounded so a self-referencing object cannot loop forever.
  let current = err as { code?: string; constraint?: string; cause?: unknown } | null | undefined

  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code === '23505') {
      return constraint === undefined || current.constraint === constraint
    }

    current = current.cause as typeof current
  }

  return false
}