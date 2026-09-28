import { buildApp } from './app.js'
import { env } from './config/env.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

const app = await buildApp()

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection; shutting down')
  void shutdown('unhandledRejection')
})

process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception; shutting down')
  void shutdown('uncaughtException')
})

let closing = false

async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true

  app.log.info({ signal }, 'shutting down')

  const timer = setTimeout(() => {
    app.log.error({ signal }, 'graceful shutdown timed out; forcing exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref()

  try {
    await app.close()
    clearTimeout(timer)
    process.exit(0)
  } catch (err) {
    app.log.error({ err }, 'error during shutdown')
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}

try {
  await app.listen({ host: env.HOST, port: env.PORT })
  app.log.info({ url: `http://${env.HOST}:${env.PORT}`, env: env.NODE_ENV }, 'server listening')
} catch (err) {
  app.log.fatal({ err }, 'failed to start')
  process.exit(1)
}
