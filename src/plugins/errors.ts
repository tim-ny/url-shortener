import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify'
import { AppError, type ErrorCode } from '../lib/errors.js'

function sendError(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string) {
  return reply.code(statusCode).send({ error: { code, message } })
}

/** Picks the stable code for a 4xx that did not come from an AppError. */
function codeFor(error: FastifyError, statusCode: number): ErrorCode {
  if (error.validation) return 'validation_failed'
  if (statusCode === 429) return 'rate_limited'
  return 'bad_request'
}

/**
 * One response shape for everything thrown: `{ error: { code, message } }`.
 *
 * - An AppError uses its own status and code.
 * - A 4xx from Fastify or a plugin is relayed, not swallowed. Its message is
 *   deliberately client-facing, and turning a rate-limited request into a 500
 *   tells a legitimate client to retry immediately.
 * - Anything else is a bare 500. The default handler would serialise the error's
 *   own message, and for a database driver that is the failing SQL with bound
 *   values inline. The detail goes to the log and nowhere else.
 */
export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message)
    }

    const statusCode = error.statusCode ?? 500

    if (statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, codeFor(error, statusCode), error.message)
    }

    request.log.error({ err: error }, 'unhandled error')

    return sendError(reply, 500, 'internal_error', 'Internal server error.')
  })
}