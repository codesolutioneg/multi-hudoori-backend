import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { presentedToken } from '../../src/middlewares/rateLimiter';

/**
 * presentedToken only narrows a budget below the IP ceiling, it never widens
 * one, because the limiter runs before authentication. Every shape the API
 * accepts for a token must be recognised, otherwise an authenticated user
 * silently falls back to the shared IP bucket of their branch.
 */
function req(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ip: '10.1.2.3', ...overrides } as Request;
}

describe('presentedToken', () => {
  it('reads a bearer token from the Authorization header', () => {
    expect(presentedToken(req({ headers: { authorization: 'Bearer abc123' } }))).toBe('abc123');
  });

  it('trims whitespace around a bearer token', () => {
    expect(presentedToken(req({ headers: { authorization: 'Bearer  abc123  ' } }))).toBe('abc123');
  });

  it('reads a token inside a JSON-RPC params body', () => {
    expect(
      presentedToken(req({ body: { jsonrpc: '2.0', params: { token: 'rpc-token' }, id: 1 } })),
    ).toBe('rpc-token');
  });

  it('reads a token at the root of a plain body', () => {
    expect(presentedToken(req({ body: { token: 'plain-token' } }))).toBe('plain-token');
  });

  it('reads rpcParams when the parser has already run', () => {
    expect(presentedToken(req({ rpcParams: { token: 'parsed-token' } } as Partial<Request>))).toBe(
      'parsed-token',
    );
  });

  it('prefers the header over the body when both carry a token', () => {
    expect(
      presentedToken(
        req({
          headers: { authorization: 'Bearer header-token' },
          body: { params: { token: 'body-token' } },
        }),
      ),
    ).toBe('header-token');
  });

  it('returns null for an unauthenticated request', () => {
    expect(presentedToken(req())).toBeNull();
  });

  it('returns null for a non-bearer Authorization scheme', () => {
    expect(presentedToken(req({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }))).toBeNull();
  });

  it('returns null for an empty bearer token', () => {
    expect(presentedToken(req({ headers: { authorization: 'Bearer ' } }))).toBeNull();
  });

  it('returns null when the body token is not a non-empty string', () => {
    expect(presentedToken(req({ body: { params: { token: 12345 } } }))).toBeNull();
    expect(presentedToken(req({ body: { params: { token: '' } } }))).toBeNull();
  });

  it('tolerates a missing, null or non-object body', () => {
    expect(presentedToken(req({ body: undefined }))).toBeNull();
    expect(presentedToken(req({ body: null }))).toBeNull();
    expect(presentedToken(req({ body: 'a string' }))).toBeNull();
  });

  it('distinguishes two callers', () => {
    expect(presentedToken(req({ body: { params: { token: 'user-a' } } }))).not.toBe(
      presentedToken(req({ body: { params: { token: 'user-b' } } })),
    );
  });
});
