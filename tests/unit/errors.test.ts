import { describe, expect, it } from 'vitest'
import {
  AppError,
  emailTaken,
  invalidCredentials,
  isUniqueViolation,
  notFound,
  unauthorized,
} from '../../src/lib/errors.js'

describe('AppError', () => {
  it('carries a machine code and an HTTP status separately', () => {
    const err = new AppError('bad_request', 422, 'nope')

    expect(err.code).toBe('bad_request')
    expect(err.statusCode).toBe(422)
    expect(err.message).toBe('nope')
  })

  it('is a real Error, so stacks and instanceof work', () => {
    const err = emailTaken()

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
    expect(err.stack).toBeTruthy()
  })
})

describe('the not-found helper', () => {
  it('is the only source of a 404, with one fixed code and message', () => {
    // The rule: a 403 would confirm the resource is real, so "not yours" and
    // "does not exist" must be indistinguishable in the response.
    const error = notFound()

    expect(error.statusCode).toBe(404)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('Link not found.')
  })
})

describe('credential errors', () => {
  it('uses one message for both wrong-email and wrong-password', () => {
    expect(invalidCredentials().message).toBe('Email or password is incorrect.')
  })

  it('does not echo the submitted email', () => {
    expect(invalidCredentials().message).not.toContain('victim@example.com')
  })

  it('defaults the 401 message', () => {
    expect(unauthorized().message).toBe('A valid API key is required.')
    expect(unauthorized('custom').message).toBe('custom')
  })
})

describe('isUniqueViolation', () => {
  const pgError = (code: string, constraint?: string) =>
    Object.assign(new Error('duplicate key'), { code, constraint })

  it('detects a 23505', () => {
    expect(isUniqueViolation(pgError('23505', 'users_email_idx'))).toBe(true)
  })

  it('looks through the wrapper Drizzle puts around driver errors', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23505', 'users_email_idx') })

    expect(isUniqueViolation(wrapped, 'users_email_idx')).toBe(true)
  })

  it('stops at a bounded depth rather than looping forever', () => {
    const loop: { code?: string; cause?: unknown } = { code: '99999' }
    loop.cause = loop

    expect(isUniqueViolation(loop)).toBe(false)
  })

  it('ignores a different 23505 constraint when one is named', () => {
    expect(isUniqueViolation(pgError('23505', 'api_keys_key_hash_idx'), 'users_email_idx')).toBe(
      false,
    )
  })

  it('matches any 23505 when no constraint is named', () => {
    expect(isUniqueViolation(pgError('23505', 'anything_at_all'))).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false)
    expect(isUniqueViolation(pgError('23503'))).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation('a string')).toBe(false)
  })
})