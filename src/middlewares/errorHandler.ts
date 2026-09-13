import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { jsonRpcFail } from './jsonRpc';
import { logger } from '../utils/logger';

/** Map the Prisma failures that represent ordinary business outcomes. */
function fromPrisma(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (err.code) {
    case 'P2025': // update/delete targeted a row that does not exist
      return new NotFoundError('Record not found', 'NOT_FOUND');
    case 'P2002': // unique constraint
      return new AppError('Record already exists', 400, 'DUPLICATE');
    case 'P2003': // foreign key constraint
      return new AppError('Related record not found', 400, 'VALIDATION_ERROR');
    default:
      return null;
  }
}

/**
 * body-parser and friends attach a 4xx status (malformed JSON, payload too
 * large). Those are client faults and must not be reported as server errors.
 */
function fromHttpError(err: unknown): AppError | null {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
  const message = status === 413 ? 'Request body is too large' : 'Malformed request body';
  return new AppError(message, status, code);
}

function fromTenantError(err: unknown): AppError | null {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (msg === 'COMPANY_CONTEXT_REQUIRED' || msg.startsWith('COMPANY_CONTEXT_REQUIRED:')) {
    return new AppError('Company context required', 403, 'COMPANY_CONTEXT_REQUIRED');
  }
  if (msg === 'RECORD_NOT_FOUND_IN_COMPANY') {
    return new NotFoundError('Record not found', 'NOT_FOUND');
  }
  return null;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const id = req.rpcId;

  const mapped =
    err instanceof AppError
      ? err
      : (fromTenantError(err) ?? fromPrisma(err) ?? fromHttpError(err));
  if (mapped) {
    if (mapped.statusCode >= 500) {
      logger.error(
        { err, path: req.path, errorCode: mapped.errorCode },
        mapped.message,
      );
    }
    jsonRpcFail(res, mapped.message, mapped.errorCode, id, mapped.statusCode >= 500 ? 500 : 200);
    return;
  }

  // Unexpected failure: log the detail, return a generic message. Internal
  // error text can name modules, columns and file paths.
  logger.error({ err, path: req.path }, 'Unhandled error');
  jsonRpcFail(res, 'Internal server error', 'SERVER_ERROR', id, 500);
}
