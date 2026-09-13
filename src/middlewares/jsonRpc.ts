import { Request, Response, NextFunction } from 'express';

export function jsonRpcParser(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && body.jsonrpc === '2.0') {
    const params = (body.params as Record<string, unknown>) ?? {};
    req.rpcParams = params;
    req.rpcId = body.id as number | string | undefined;
  } else {
    req.rpcParams = (body as Record<string, unknown>) ?? {};
  }
  next();
}

export function jsonRpcSuccess(res: Response, data: unknown, id?: number | string): void {
  res.json({
    jsonrpc: '2.0',
    result: data,
    id: id ?? null,
  });
}

export function jsonRpcFail(
  res: Response,
  message: string,
  errorCode: string,
  id?: number | string,
  status = 200,
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    result: {
      success: false,
      message,
      error_code: errorCode,
    },
    id: id ?? null,
  });
}

export function biotimeOk(data: unknown, meta?: Record<string, unknown>) {
  const payload: Record<string, unknown> = { success: true, data: data ?? {} };
  if (meta) payload.meta = meta;
  return payload;
}

export function biotimeFail(
  message: string,
  errorCode = 'ERROR',
  extra?: Record<string, unknown>,
) {
  return { success: false, message, error_code: errorCode, ...extra };
}
