import type { FastifyInstance } from 'fastify'
import { AppError } from '../lib/errors.js'

const PASS_THROUGH_MIN = 400
const PASS_THROUGH_MAX = 499

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { statusCode } = error as { statusCode?: unknown }
  return typeof statusCode === 'number' ? statusCode : undefined
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toBody())
    }

    const isValidationError =
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      Boolean((error as { validation?: unknown }).validation)

    if (isValidationError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: messageOf(error, 'Request validation failed.'),
        },
      })
    }

    const status = statusOf(error)
    if (status !== undefined && status >= PASS_THROUGH_MIN && status <= PASS_THROUGH_MAX) {
      const code = status === 429 ? 'rate_limited' : 'bad_request'
      return reply.code(status).send({
        error: { code, message: messageOf(error, `Request failed with status ${status}.`) },
      })
    }

    request.log.error({ err: error }, 'unhandled error')

    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error.' },
    })
  })
}
