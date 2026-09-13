import type { Request } from 'express';

/**
 * The single place that knows where a caller may put their API token.
 *
 * Both the authentication middleware and the rate limiter need this, and they
 * must agree: if they disagree, a caller can be authenticated under one token
 * while being budgeted under a different key.
 *
 * Three accepted positions, in precedence order:
 *   1. `Authorization: Bearer <token>`
 *   2. `req.rpcParams.token`, once jsonRpcParser has run
 *   3. the raw parsed body, `params.token` for JSON-RPC or `token` for a plain
 *      body, which is what the rate limiter sees because it is mounted before
 *      jsonRpcParser
 */
export function extractRequestToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }

  const fromParsed = req.rpcParams?.token;
  if (typeof fromParsed === 'string' && fromParsed) return fromParsed;

  const body = req.body as { token?: unknown; params?: { token?: unknown } } | undefined;
  if (!body || typeof body !== 'object') return null;
  const fromBody = body.params?.token ?? body.token;
  return typeof fromBody === 'string' && fromBody ? fromBody : null;
}
