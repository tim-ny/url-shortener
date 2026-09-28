import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { extractBearerToken } from '../../src/modules/auth/guards.js'

function requestWith(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}

describe('extractBearerToken', () => {
  it('reads a well-formed bearer token', () => {
    expect(extractBearerToken(requestWith({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('accepts any capitalisation of the scheme', () => {
    expect(extractBearerToken(requestWith({ authorization: 'bearer abc123' }))).toBe('abc123')
    expect(extractBearerToken(requestWith({ authorization: 'BEARER abc123' }))).toBe('abc123')
  })

  it('tolerates extra whitespace after the scheme', () => {
    expect(extractBearerToken(requestWith({ authorization: 'Bearer    abc123' }))).toBe('abc123')
  })

  it('returns null for every malformed variant', () => {
    expect(extractBearerToken(requestWith({}))).toBeNull()
    expect(extractBearerToken(requestWith({ authorization: '' }))).toBeNull()
    expect(extractBearerToken(requestWith({ authorization: 'abc123' }))).toBeNull()
    expect(extractBearerToken(requestWith({ authorization: 'Basic abc123' }))).toBeNull()
    expect(extractBearerToken(requestWith({ authorization: 'Bearer' }))).toBeNull()
    expect(extractBearerToken(requestWith({ authorization: 'Bearer    ' }))).toBeNull()
  })

  it('does not distinguish absent from malformed', () => {
    expect(extractBearerToken(requestWith({}))).toBe(
      extractBearerToken(requestWith({ authorization: 'nope' })),
    )
  })

  it('rejects a repeated header', () => {
    const request = {
      headers: { authorization: ['Bearer a', 'Bearer b'] },
    } as unknown as FastifyRequest
    expect(extractBearerToken(request)).toBeNull()
  })
})
