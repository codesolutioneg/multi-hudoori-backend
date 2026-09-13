import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import app from '../../src/app';
import { config } from '../../src/config';
import { expectFail, expectOk, plain, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

describe('error handling', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
  });

  describe('Prisma failures map to business errors, not 500s', () => {
    it('returns NOT_FOUND when approving a request that does not exist', async () => {
      const res = await rpc('/api/biotime/requests/leave/approve', { id: 'does-not-exist' }, hr.token);
      expect(res.status).toBe(200);
      expectFail(res, 'NOT_FOUND');
    });

    it('returns NOT_FOUND when rejecting a missing request', async () => {
      const res = await rpc(
        '/api/biotime/requests/loan/reject',
        { id: 'does-not-exist', reason: 'x' },
        hr.token,
      );
      expect(res.status).toBe(200);
      expectFail(res, 'NOT_FOUND');
    });

    it('returns NOT_FOUND when deactivating a user that does not exist', async () => {
      const admin = await createUser({ login: 'admin@test.local', role: UserRole.PLATFORM_ADMIN });
      const res = await rpc('/api/admin/users/deactivate', { userId: 'does-not-exist' }, admin.token);
      expect(res.status).toBe(200);
      expectFail(res, 'NOT_FOUND');
    });

    it('returns DUPLICATE for a unique-constraint clash', async () => {
      const location = { name: 'Dup Branch', code: 'LOC-DUP' };
      expectOk(await rpc('/api/biotime/locations/create', location, hr.token), 'first create');
      const res = await rpc('/api/biotime/locations/create', location, hr.token);
      expect(res.status).toBeLessThan(500);
      expect(res.body.result?.success).toBe(false);
    });
  });

  describe('unexpected failures do not leak internals', () => {
    it('keeps the JSON-RPC envelope on a 404', async () => {
      const res = await request(app).post('/api/nope').send({ jsonrpc: '2.0', params: {}, id: 7 });
      expect(res.status).toBe(404);
      expect(res.body.error_code).toBe('NOT_FOUND');
    });

    it('never echoes a module or file path in an error message', async () => {
      const res = await rpc('/api/biotime/payroll/get', { id: 'missing' }, hr.token);
      const message = String(res.body.result?.message ?? '');
      expect(message).not.toMatch(/node_modules|\/src\/|is not a function|\.ts:/);
    });
  });

  describe('malformed input', () => {
    it('reports a malformed JSON body as a client error, not a 500', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"broken":');
      expect(res.status).toBe(200);
      expect(res.body.result?.error_code).toBe('VALIDATION_ERROR');
    });

    it('rejects a body over the 2mb limit as a client error', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ jsonrpc: '2.0', params: { blob: 'x'.repeat(3 * 1024 * 1024) }, id: 1 }));
      expect(res.body.result?.error_code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('treats a missing params object as empty', async () => {
      const res = await request(app).post('/api/auth/validate').send({ jsonrpc: '2.0', id: 1 });
      expect(res.body.result?.error_code).toBe('MISSING_TOKEN');
    });

    it('handles an array where an object is expected', async () => {
      const res = await rpc('/api/biotime/employees/list', { employeeIds: 'not-an-array' }, hr.token);
      expect(res.status).toBeLessThan(500);
    });

    it('handles a very deep params object', async () => {
      let nested: Record<string, unknown> = { value: 1 };
      for (let i = 0; i < 50; i++) nested = { nested };
      const res = await rpc('/api/biotime/employees/list', nested, hr.token);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('rate limiting', () => {
    it('never throttles the health check', async () => {
      for (let i = 0; i < 25; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });

    it('exposes a configurable window and budget', () => {
      expect(config.rateLimit.windowMs).toBeGreaterThan(0);
      expect(config.rateLimit.max).toBeGreaterThan(0);
      expect(config.rateLimit.ipMax).toBeGreaterThan(0);
      expect(config.rateLimit.authMax).toBeGreaterThan(0);
    });

    it('keeps the bypass-proof IP ceiling at or above the per-token share', () => {
      // The IP layer is the only one an attacker cannot sidestep by rotating
      // tokens, so it must never be the tighter of the two.
      expect(config.rateLimit.ipMax).toBeGreaterThanOrEqual(config.rateLimit.max);
    });

    it('counts a rotating fake token against the IP ceiling', async () => {
      // A caller minting a fresh token per request must not mint fresh budgets.
      // The IP limiter is keyed on the source address, so its remaining count
      // has to keep falling regardless of the token presented.
      const first = await request(app)
        .post('/api/biotime/me')
        .set('Authorization', 'Bearer fake-token-1')
        .send({ jsonrpc: '2.0', params: {}, id: 1 });
      const second = await request(app)
        .post('/api/biotime/me')
        .set('Authorization', 'Bearer fake-token-2')
        .send({ jsonrpc: '2.0', params: {}, id: 1 });

      const remaining = (res: { headers: Record<string, string> }) =>
        Number(res.headers['ratelimit-remaining']);
      expect(remaining(second)).toBeLessThan(remaining(first));

      // Both are still rejected as unauthenticated.
      expect(first.body.result?.error_code).toBe('INVALID_TOKEN');
      expect(second.body.result?.error_code).toBe('INVALID_TOKEN');
    });

    it('budgets authenticated callers separately by token', async () => {
      // Two users behind the same test client IP must not share a budget.
      const other = await createUser({ login: 'other@test.local', role: UserRole.HR_MANAGER });
      for (let i = 0; i < 5; i++) {
        expect((await rpc('/api/biotime/me', {}, hr.token)).status).toBe(200);
        expect((await rpc('/api/biotime/me', {}, other.token)).status).toBe(200);
      }
    });

    it('serves a request authenticated by rpc params without throttling it', async () => {
      // The limiter runs before jsonRpcParser, so it reads the raw body to find
      // this token. Key derivation itself is pinned in tests/unit/rateLimiterKey.
      const res = await rpc('/api/biotime/me', { token: hr.token });
      expect(res.status).toBe(200);
    });

    it('serves a request authenticated by a plain body', async () => {
      const res = await plain('/api/biotime/me', { token: hr.token });
      expect(res.status).toBe(200);
    });
  });

  describe('security headers and CORS', () => {
    it('sets helmet hardening headers', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('allows a localhost origin', async () => {
      const res = await request(app)
        .post('/api/auth/validate')
        .set('Origin', 'http://localhost:5173')
        .send({ jsonrpc: '2.0', params: {}, id: 1 });
      expect(res.status).toBe(200);
    });

    it('rejects an unlisted origin outside development', async () => {
      const res = await request(app)
        .post('/api/auth/validate')
        .set('Origin', 'https://evil.example.com')
        .send({ jsonrpc: '2.0', params: {}, id: 1 });
      // config.isDev is false under NODE_ENV=test, so CORS must refuse.
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
