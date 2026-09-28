import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    testTimeout: 30_000,
    hookTimeout: 30_000,

    fileParallelism: false,

    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://shortener:shortener@localhost:5432/shortener_test',
      REDIS_URL: 'redis://localhost:6379',
      APP_SECRET: 'test-only-secret-not-used-against-real-data-32b',
      LOG_LEVEL: 'info',
    },
  },
})
