import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import app from '../../src/app';
import { prisma } from '../../src/prisma/client';
import { PLATFORM_ADMIN_LOCAL_TOKEN } from '../../src/config';
import { expectFail, expectOk, expectRpcEnvelope, plain, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase } from '../helpers/db';

describe('auth', () => {
  let userLogin: string;
  let userPassword: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser({
      login: 'hr@test.local',
      role: UserRole.HR_MANAGER,
      name: 'HR Manager',
      password: 'HrManager#2026',
    });
    userLogin = user.login;
    userPassword = user.password;
  });

  describe('POST /api/auth/login', () => {
    it('issues a token for valid credentials', async () => {
      const res = await rpc('/api/auth/login', { login: userLogin, password: userPassword });
      const data = expectOk(res);
      expect(data.token).toBeTypeOf('string');
      expect(String(data.token)).toHaveLength(64);
      expect(data.expiry_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(data.user).toMatchObject({ login: userLogin, role: UserRole.HR_MANAGER });
    });

    it('persists the token so it authenticates later requests', async () => {
      const login = await rpc('/api/auth/login', { login: userLogin, password: userPassword });
      const token = String(expectOk(login).token);
      const me = await rpc('/api/biotime/me', {}, token);
      expect(expectOk(me).user).toMatchObject({ login: userLogin });
    });

    it('accepts a plain (non JSON-RPC) body too', async () => {
      const res = await plain('/api/auth/login', { login: userLogin, password: userPassword });
      expect(expectOk(res).token).toBeTruthy();
    });

    it('is case-insensitive on the email login', async () => {
      const res = await rpc('/api/auth/login', {
        login: userLogin.toUpperCase(),
        password: userPassword,
      });
      expectOk(res);
    });

    it('rejects a wrong password', async () => {
      const res = await rpc('/api/auth/login', { login: userLogin, password: 'wrong-password' });
      expectFail(res, 'INVALID_CREDENTIALS');
    });

    it('rejects an unknown login', async () => {
      const res = await rpc('/api/auth/login', { login: 'nobody@test.local', password: 'whatever12' });
      expectFail(res, 'INVALID_CREDENTIALS');
    });

    it('rejects a deactivated user', async () => {
      await prisma.user.updateMany({ where: { login: userLogin }, data: { active: false } });
      const res = await rpc('/api/auth/login', { login: userLogin, password: userPassword });
      expectFail(res, 'INVALID_CREDENTIALS');
    });

    it('validates a missing login', async () => {
      expectFail(await rpc('/api/auth/login', { password: 'abcdef' }), 'LOGIN_REQUIRED');
    });

    it('validates a missing password', async () => {
      expectFail(await rpc('/api/auth/login', { login: userLogin }), 'PASSWORD_REQUIRED');
    });

    it('validates a too-short password', async () => {
      expectFail(await rpc('/api/auth/login', { login: userLogin, password: 'abc' }), 'PASSWORD_TOO_SHORT');
    });

    it('validates a malformed email', async () => {
      expectFail(await rpc('/api/auth/login', { login: 'not@an', password: 'abcdef' }), 'INVALID_EMAIL');
    });

    it('validates a too-short login', async () => {
      expectFail(await rpc('/api/auth/login', { login: 'ab', password: 'abcdef' }), 'LOGIN_TOO_SHORT');
    });

    it('does not leak whether the login exists', async () => {
      const unknown = await rpc('/api/auth/login', { login: 'ghost@test.local', password: 'abcdef12' });
      const wrongPass = await rpc('/api/auth/login', { login: userLogin, password: 'abcdef12' });
      expect(unknown.body.result?.message).toBe(wrongPass.body.result?.message);
    });

    it('records the device info on the token', async () => {
      const res = await rpc('/api/auth/login', {
        login: userLogin,
        password: userPassword,
        device_info: 'Pixel 8 / Android 15',
      });
      const token = String(expectOk(res).token);
      const row = await prisma.apiToken.findUnique({ where: { token } });
      expect(row?.deviceInfo).toBe('Pixel 8 / Android 15');
    });

    it('truncates an over-long device info string', async () => {
      const res = await rpc('/api/auth/login', {
        login: userLogin,
        password: userPassword,
        device_info: 'x'.repeat(400),
      });
      const token = String(expectOk(res).token);
      const row = await prisma.apiToken.findUnique({ where: { token } });
      expect(row?.deviceInfo).toHaveLength(255);
    });
  });

  describe('POST /api/auth/validate', () => {
    it('accepts a live token', async () => {
      const user = await createUser({ login: 'v1@test.local', role: UserRole.HR_USER });
      const res = await rpc('/api/auth/validate', { token: user.token });
      expect(expectOk(res).valid).toBe(true);
    });

    it('reads the token from the Authorization header', async () => {
      const user = await createUser({ login: 'v2@test.local', role: UserRole.HR_USER });
      const res = await rpc('/api/auth/validate', {}, user.token);
      expect(expectOk(res).valid).toBe(true);
    });

    it('rejects a missing token', async () => {
      expectFail(await rpc('/api/auth/validate', {}), 'MISSING_TOKEN');
    });

    it('rejects an unknown token', async () => {
      expectFail(await rpc('/api/auth/validate', { token: 'nope' }), 'INVALID_TOKEN');
    });

    it('rejects an expired token', async () => {
      const user = await createUser({ login: 'v3@test.local', role: UserRole.HR_USER });
      await prisma.apiToken.update({
        where: { token: user.token },
        data: { expiryDate: new Date(Date.now() - 1000) },
      });
      expectFail(await rpc('/api/auth/validate', { token: user.token }), 'INVALID_TOKEN');
    });

    it('rejects a token whose user was deactivated', async () => {
      const user = await createUser({ login: 'v4@test.local', role: UserRole.HR_USER });
      await prisma.user.update({ where: { id: user.userId }, data: { active: false } });
      expectFail(await rpc('/api/auth/validate', { token: user.token }), 'INVALID_TOKEN');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('deletes the token and stops authenticating it', async () => {
      const user = await createUser({ login: 'l1@test.local', role: UserRole.HR_USER });
      expectOk(await rpc('/api/auth/logout', { token: user.token }));
      expect(await prisma.apiToken.findUnique({ where: { token: user.token } })).toBeNull();
      expectFail(await rpc('/api/biotime/me', {}, user.token), 'INVALID_TOKEN');
    });

    it('is idempotent for an unknown token', async () => {
      expectOk(await rpc('/api/auth/logout', { token: 'never-existed' }));
    });

    it('succeeds without any token', async () => {
      expectOk(await rpc('/api/auth/logout', {}));
    });
  });

  describe('token handling on protected routes', () => {
    it('rejects a request with no token', async () => {
      expectFail(await rpc('/api/biotime/me', {}), 'MISSING_TOKEN');
    });

    it('accepts the token in the rpc params instead of the header', async () => {
      const user = await createUser({ login: 't1@test.local', role: UserRole.HR_USER });
      expectOk(await rpc('/api/biotime/me', { token: user.token }));
    });

    it('rejects an expired token on a protected route', async () => {
      const user = await createUser({ login: 't2@test.local', role: UserRole.HR_USER });
      await prisma.apiToken.update({
        where: { token: user.token },
        data: { expiryDate: new Date(Date.now() - 1000) },
      });
      expectFail(await rpc('/api/biotime/me', {}, user.token), 'INVALID_TOKEN');
    });

    it('rejects a deactivated user on a protected route', async () => {
      const user = await createUser({ login: 't3@test.local', role: UserRole.HR_USER });
      await prisma.user.update({ where: { id: user.userId }, data: { active: false } });
      expectFail(await rpc('/api/biotime/me', {}, user.token), 'INVALID_TOKEN');
    });

    it('honours the offline platform-admin local token', async () => {
      const res = await rpc('/api/biotime/dashboard/stats', {}, PLATFORM_ADMIN_LOCAL_TOKEN);
      expectOk(res);
    });
  });

  describe('transport envelope', () => {
    it('echoes the JSON-RPC id', async () => {
      const res = await request(app)
        .post('/api/auth/validate')
        .send({ jsonrpc: '2.0', params: {}, id: 4242 });
      expect(res.body.id).toBe(4242);
    });

    it('returns id null for a plain body', async () => {
      const res = await plain('/api/auth/validate', {});
      expect(res.body.id).toBeNull();
    });

    it('always wraps responses in a JSON-RPC envelope', async () => {
      expectRpcEnvelope(await rpc('/api/auth/validate', {}));
    });

    it('returns HTTP 200 for business failures', async () => {
      const res = await rpc('/api/auth/login', { login: userLogin, password: 'wrong-one' });
      expect(res.status).toBe(200);
    });
  });

  describe('service endpoints', () => {
    it('exposes an unauthenticated health check', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { status: 'ok', service: 'biotime-backend' },
      });
    });

    it('returns a 404 envelope for an unknown route', async () => {
      const res = await request(app).post('/api/does-not-exist').send({});
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error_code: 'NOT_FOUND' });
    });
  });
});
