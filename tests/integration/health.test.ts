import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
})

function waitForRedisStatus(target: 'ready' | 'end', timeoutMs = 5_000): Promise<void> {
  if (app.cache.status === target) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      app.cache.off('ready', onChange)
      app.cache.off('end', onChange)
    }

    const onChange = () => {
      if (app.cache.status !== target) return
      cleanup()
      resolve()
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`redis stuck at '${app.cache.status}', wanted '${target}'`))
    }, timeoutMs)

    app.cache.on('ready', onChange)
    app.cache.on('end', onChange)
  })
}

async function takeRedisDown(): Promise<void> {
  if (app.cache.status === 'end') return
  app.cache.disconnect()
  await waitForRedisStatus('end')
}

async function bringRedisUp(): Promise<void> {
  if (app.cache.status === 'ready') return
  if (app.cache.status === 'end') await app.cache.connect()
  await waitForRedisStatus('ready')
}

describe('GET /livez', () => {
  it('reports alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/livez' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
  })

  it('does not consult any dependency', async () => {
    await takeRedisDown()
    try {
      const res = await app.inject({ method: 'GET', url: '/livez' })
      expect(res.statusCode).toBe(200)
    } finally {
      await bringRedisUp()
    }
  })
})

describe('GET /readyz', () => {
  it('is ok when both dependencies are reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.checks).toEqual({ postgres: 'up', redis: 'up' })
  })

  it('reports degraded but stays ready when redis is down', async () => {
    await takeRedisDown()
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      const body = res.json()

      expect(res.statusCode).toBe(200)
      expect(body.status).toBe('degraded')
      expect(body.checks).toEqual({ postgres: 'up', redis: 'down' })
    } finally {
      await bringRedisUp()
    }
  })

  it('reports every failing check at once', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    const body = res.json()

    expect(body).toHaveProperty('checks.postgres')
    expect(body).toHaveProperty('checks.redis')
  })
})
