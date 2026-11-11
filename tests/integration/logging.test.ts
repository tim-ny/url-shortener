import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { captureLogs } from '../helpers.js'

const API_KEY = 'usk_live_TOTALLYFAKEKEYDONOTLOGME1234'

let app: FastifyInstance
const logs = captureLogs()

beforeAll(async () => {
  app = await buildApp({ logSink: logs.sink })
})

afterAll(async () => {
  await app?.close()
})

describe('credentials never reach the log', () => {
  it('drops the Authorization header from a real request', async () => {
    logs.reset()

    await app.inject({
      method: 'GET',
      url: '/livez',
      headers: { authorization: `Bearer ${API_KEY}`, cookie: 'session=abc123' },
    })
    const output = await logs.read()

    expect(output).not.toBe('')
    expect(output).toContain('/livez')
    expect(output).not.toContain(API_KEY)
    expect(output).not.toContain('session=abc123')
  })

  it('never serializes request headers onto req', async () => {
    logs.reset()

    await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    const output = await logs.read()

    for (const line of output.trim().split('\n')) {
      const parsed = JSON.parse(line) as { req?: Record<string, unknown> }
      if (parsed.req) expect(parsed.req).not.toHaveProperty('headers')
    }
  })
})

describe('redact paths catch what the serializer misses', () => {
  it('redacts an Authorization header logged at the top level', async () => {
    logs.reset()

    app.log.info({ headers: { authorization: `Bearer ${API_KEY}` } }, 'top level headers')
    const output = await logs.read()

    expect(output).toContain('top level headers')
    expect(output).toContain('[redacted]')
    expect(output).not.toContain(API_KEY)
  })

  it('redacts a cookie logged at the top level', async () => {
    logs.reset()

    app.log.info({ headers: { cookie: 'session=abc123' } }, 'top level cookie')
    const output = await logs.read()

    expect(output).toContain('top level cookie')
    expect(output).not.toContain('session=abc123')
  })

  it('leaves non-sensitive headers alone', async () => {
    logs.reset()

    app.log.info({ headers: { accept: 'application/json' } }, 'harmless headers')

    expect(await logs.read()).toContain('application/json')
  })
})