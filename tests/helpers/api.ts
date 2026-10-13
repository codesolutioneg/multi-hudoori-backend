import request from 'supertest';
import { expect } from 'vitest';
import app from '../../src/app';

export type RpcResult = {
  status: number;
  body: {
    jsonrpc?: string;
    id?: number | string | null;
    result?: {
      success?: boolean;
      message?: string;
      error_code?: string;
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
  };
};

/** POST a JSON-RPC 2.0 envelope, the shape the Flutter client sends. */
export async function rpc(
  path: string,
  params: Record<string, unknown> = {},
  token?: string,
): Promise<RpcResult> {
  const req = request(app).post(path).set('Content-Type', 'application/json');
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req.send({ jsonrpc: '2.0', params, id: 1 });
  return { status: res.status, body: res.body };
}

/** POST a plain (non-JSON-RPC) body. The API accepts both. */
export async function plain(
  path: string,
  body: Record<string, unknown> = {},
  token?: string,
): Promise<RpcResult> {
  const req = request(app).post(path).set('Content-Type', 'application/json');
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req.send(body);
  return { status: res.status, body: res.body };
}

export function expectOk(res: RpcResult, context = ''): Record<string, unknown> {
  const label = context ? ` (${context})` : '';
  expect(
    res.body.result?.success,
    `expected success${label}, got: ${JSON.stringify(res.body.result)}`,
  ).toBe(true);
  return res.body.result?.data ?? {};
}

export function expectFail(res: RpcResult, errorCode?: string): void {
  expect(res.body.result?.success).toBe(false);
  if (errorCode) expect(res.body.result?.error_code).toBe(errorCode);
}

/** Every route returns HTTP 200 with a JSON-RPC envelope, even on business errors. */
export function expectRpcEnvelope(res: RpcResult): void {
  expect(res.body.jsonrpc).toBe('2.0');
  expect(res.body).toHaveProperty('result');
  expect(res.body).toHaveProperty('id');
}

export type RpcSurfaceKind =
  | 'ROUTE_OK'
  | 'BUSINESS_FAIL'
  | 'HTTP_404'
  | 'HTTP_5XX'
  | 'BAD_ENVELOPE';

/** Classify whether a mobile surface call reached a handler (vs missing route / crash). */
export function classifyRpcSurface(res: RpcResult): RpcSurfaceKind {
  if (res.status === 404) return 'HTTP_404';
  if (res.status >= 500) return 'HTTP_5XX';
  if (res.body.jsonrpc === '2.0' && res.body.result !== undefined) {
    return res.body.result.success === true ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  const nested = res.body.result as { success?: boolean } | undefined;
  if (nested?.success === true || nested?.success === false) {
    return nested.success ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  const plain = res.body as { success?: boolean };
  if (typeof plain.success === 'boolean') {
    return plain.success ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  return 'BAD_ENVELOPE';
}
