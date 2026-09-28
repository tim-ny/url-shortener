import { describe, expect, it } from 'vitest'
import {
  AppError,
  badRequest,
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
  })

  it('serialises to the single documented body shape', () => {
    expect(unauthorized().toBody()).toEqual({
      error: { code: 'unauthorized', message: 'A valid API key is required.' },
    })
  })

  it('is a real Error, so stacks and instanceof work', () => {
    const err = emailTaken()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
    expect(err.stack).toBeTruthy()
  })
})

describe('the not-found helper', () => {
  it('gives one message for both causes', () => {
    const nonexistent = notFound()
    const unowned = notFound()

    expect(unowned.statusCode).toBe(nonexistent.statusCode)
    expect(unowned.toBody()).toEqual(nonexistent.toBody())
  })
})

describe('credential errors', () => {
  it('uses one message for both wrong-email and wrong-password', () => {
    expect(invalidCredentials().message).toBe('Email or password is incorrect.')
  })

  it('does not echo the submitted email', () => {
    const email = 'victim@example.com'
    expect(invalidCredentials().message).not.toContain(email)
  })
})

describe('isUniqueViolation', () => {
  const pgError = (code: string, constraint?: string) =>
    Object.assign(new Error('duplicate key'), { code, constraint })

  it('detects a 23505 at the top level', () => {
    expect(isUniqueViolation(pgError('23505', 'users_email_idx'))).toBe(true)
  })

  it('walks the cause chain', () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('inner'), { cause: pgError('23505', 'users_email_idx') }),
    })
    expect(isUniqueViolation(wrapped, 'users_email_idx')).toBe(true)
  })

  it('stops at a bounded depth rather than looping forever', () => {
    const loop: { code?: string; cause?: unknown } = { code: '99999' }
    loop.cause = loop

    expect(() => isUniqueViolation(loop)).not.toThrow()
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

describe('badRequest', () => {
  it('keeps the caller’s message', () => {
    expect(badRequest('url is not allowed').message).toBe('url is not allowed')
  })
})
