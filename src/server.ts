import { buildApp } from './app.js'
import { env } from './config/env.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

const app = await buildApp()

let closing = false

async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true

  app.log.info({ signal }, 'shutting down')

  // `close()` waits for in-flight requests; this stops us waiting forever.
  const timer = setTimeout(() => {
    app.log.error({ signal }, 'graceful shutdown timed out; forcing exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref()

  try {
    await app.close()
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
} catch (err) {
  app.log.error({ err }, 'failed to start')
  process.exit(1)
}