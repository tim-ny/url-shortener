import { loadEnvFile } from 'node:process'
import { buildReservedCodes, loadEnv } from './schema.js'

try {
  loadEnvFile('.env')
} catch {}

export const env: Readonly<ReturnType<typeof loadEnv>> = Object.freeze(loadEnv())

export const reservedCodes = buildReservedCodes(env.RESERVED_CODES)
