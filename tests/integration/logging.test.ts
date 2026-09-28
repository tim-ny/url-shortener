import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'

const API_KEY = 'usk_live_TOTALLYFAKEKEYDONOTLOGME1234'

let app: FastifyInstance
let output = ''

beforeAll(async () => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  })

  app = await buildApp({ logDestination: stream })
})

afterAll(async () => {
  await app?.close()
})

beforeEach(() => {
  output = ''
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

describe('credentials never reach the log', () => {
  it('drops the Authorization header from a real request', async () => {
    await app.inject({
      method: 'GET',
      url: '/livez',
      headers: { authorization: `Bearer ${API_KEY}`, cookie: 'session=abc123' },
    })
    await flush()

    expect(output).not.toBe('')
    expect(output).toContain('/livez')
    expect(output).not.toContain(API_KEY)
    expect(output).not.toContain('session=abc123')
  })

  it('never serializes request headers onto req', async () => {
    await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    await flush()

    for (const line of output.trim().split('\n')) {
      const parsed = JSON.parse(line) as { req?: Record<string, unknown> }
      if (parsed.req) {
        expect(parsed.req).not.toHaveProperty('headers')
      }
    }
  })
})

describe('redact paths catch what the serializer misses', () => {
  it('redacts an Authorization header logged at the top level', async () => {
    app.log.info({ headers: { authorization: `Bearer ${API_KEY}` } }, 'top level headers')
    await flush()

    expect(output).toContain('top level headers')
    expect(output).toContain('[redacted]')
    expect(output).not.toContain(API_KEY)
  })

  it('redacts a cookie logged at the top level', async () => {
    app.log.info({ headers: { cookie: 'session=abc123' } }, 'top level cookie')
    await flush()

    expect(output).toContain('top level cookie')
    expect(output).not.toContain('session=abc123')
  })

  it('leaves non-sensitive headers alone', async () => {
    app.log.info({ headers: { accept: 'application/json' } }, 'harmless headers')
    await flush()

    expect(output).toContain('application/json')
  })
})
