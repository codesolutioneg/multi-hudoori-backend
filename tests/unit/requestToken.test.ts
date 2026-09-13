import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { extractRequestToken } from '../../src/utils/requestToken';

/**
 * Authentication and rate limiting both call this. If they ever disagreed about
 * where a token lives, a caller could be authenticated under one token while
 * being budgeted under a different key.
 */
function req(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ip: '10.1.2.3', ...overrides } as Request;
}

describe('extractRequestToken', () => {
  it('reads a bearer token from the Authorization header', () => {
    expect(extractRequestToken(req({ headers: { authorization: 'Bearer abc123' } }))).toBe('abc123');
  });

  it('trims whitespace around a bearer token', () => {
    expect(extractRequestToken(req({ headers: { authorization: 'Bearer  abc123  ' } }))).toBe('abc123');
  });

  it('reads a token from parsed rpc params', () => {
    expect(
      extractRequestToken(req({ rpcParams: { token: 'parsed' } } as Partial<Request>)),
    ).toBe('parsed');
  });

  it('reads a token from a raw JSON-RPC body before the parser has run', () => {
    expect(
      extractRequestToken(req({ body: { jsonrpc: '2.0', params: { token: 'raw-rpc' }, id: 1 } })),
    ).toBe('raw-rpc');
  });

  it('reads a token from the root of a plain body', () => {
    expect(extractRequestToken(req({ body: { token: 'plain' } }))).toBe('plain');
  });

  it('applies header over params over body precedence', () => {
    expect(
      extractRequestToken(
        req({
          headers: { authorization: 'Bearer from-header' },
          rpcParams: { token: 'from-params' },
          body: { params: { token: 'from-body' } },
        } as Partial<Request>),
      ),
    ).toBe('from-header');

    expect(
      extractRequestToken(
        req({
          rpcParams: { token: 'from-params' },
          body: { params: { token: 'from-body' } },
        } as Partial<Request>),
      ),
    ).toBe('from-params');
  });

  it('returns null when no token is present anywhere', () => {
    expect(extractRequestToken(req())).toBeNull();
  });

  it('returns null for a non-bearer Authorization scheme', () => {
    expect(extractRequestToken(req({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }))).toBeNull();
  });

  it('returns null for an empty bearer token rather than an empty string', () => {
    expect(extractRequestToken(req({ headers: { authorization: 'Bearer ' } }))).toBeNull();
  });

  it('ignores a non-string or empty token value', () => {
    expect(extractRequestToken(req({ body: { params: { token: 12345 } } }))).toBeNull();
    expect(extractRequestToken(req({ body: { token: '' } }))).toBeNull();
  });

  it('tolerates a missing, null or non-object body', () => {
    expect(extractRequestToken(req({ body: undefined }))).toBeNull();
    expect(extractRequestToken(req({ body: null }))).toBeNull();
    expect(extractRequestToken(req({ body: 'a string' }))).toBeNull();
  });
});
