export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'invalid_credentials'
  | 'email_taken'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
  }
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number

  constructor(code: ErrorCode, statusCode: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message } }
  }
}

export const invalidCredentials = () =>
  new AppError('invalid_credentials', 401, 'Email or password is incorrect.')

export const emailTaken = () =>
  new AppError('email_taken', 409, 'An account with that email already exists.')

export const unauthorized = (message = 'A valid API key is required.') =>
  new AppError('unauthorized', 401, message)

export const notFound = () => new AppError('not_found', 404, 'Link not found.')

export const badRequest = (message: string) => new AppError('bad_request', 400, message)

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err

  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (candidate.code === '23505') {
      return constraint === undefined || candidate.constraint === constraint
    }
    current = candidate.cause
  }

  return false
}
