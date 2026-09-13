import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
vi.mock('../../src/prisma/client', () => ({
  prisma: {
    odooConfig: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({})),
    },
  },
}));
vi.mock('../../src/bootstrap/odooConfig', () => ({
  ensureOdooConfigFromEnv: vi.fn(),
}));

import { ensureOdooConfigFromEnv } from '../../src/bootstrap/odooConfig';
import {
  odooCall,
  odooConfigJson,
  odooFindEmployeeIdByCode,
  testOdooConnection,
} from '../../src/services/odoo/odooClient.service';

const mockedAxios = vi.mocked(axios, true);

function odooConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'odoo1',
    baseUrl: 'https://example.odoo.com',
    database: 'testdb',
    login: 'api@example.com',
    password: 'secret',
    authToken: null,
    tokenExpiry: null,
    isConnected: false,
    lastPushAt: null,
    ...overrides,
  };
}

function loginOk(token = 'odoo-token') {
  return { data: { result: { success: true, data: { token } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(odooConfig() as never);
});

describe('odooConfigJson', () => {
  it('reports configured credentials without leaking the password', () => {
    const json = odooConfigJson(odooConfig() as never);
    expect(json.credentialsConfigured).toBe(true);
    expect(JSON.stringify(json)).not.toContain('secret');
  });

  it('reports missing credentials', () => {
    const json = odooConfigJson(odooConfig({ password: '' }) as never);
    expect(json.credentialsConfigured).toBe(false);
  });

  it('serialises timestamps as ISO or null', () => {
    const json = odooConfigJson(odooConfig({ lastPushAt: new Date('2026-06-01T10:00:00Z') }) as never);
    expect(json.lastPushAt).toBe('2026-06-01T10:00:00.000Z');
    expect(odooConfigJson(odooConfig() as never).lastPushAt).toBeNull();
  });
});

describe('odooCall', () => {
  it('logs in, then posts a JSON-RPC envelope with a bearer token', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({ data: { result: { success: true, data: { items: [] } } } }) as never;

    await odooCall('/api/biotime/employees/list', { limit: 5 });

    const [loginUrl] = vi.mocked(mockedAxios.post).mock.calls[0];
    expect(loginUrl).toBe('https://example.odoo.com/api/auth/login');

    const [callUrl, callBody, callOpts] = vi.mocked(mockedAxios.post).mock.calls[1] as [
      string,
      { jsonrpc: string; params: Record<string, unknown> },
      { headers: Record<string, string> },
    ];
    expect(callUrl).toBe('https://example.odoo.com/api/biotime/employees/list');
    expect(callBody.jsonrpc).toBe('2.0');
    expect(callBody.params).toMatchObject({ token: 'odoo-token', limit: 5 });
    expect(callOpts.headers.Authorization).toBe('Bearer odoo-token');
  });

  it('strips a trailing slash from the configured base url', async () => {
    vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(
      odooConfig({ baseUrl: 'https://example.odoo.com///' }) as never,
    );
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({ data: { result: { success: true, data: {} } } }) as never;

    await odooCall('/api/ping');
    expect(vi.mocked(mockedAxios.post).mock.calls[1][0]).toBe('https://example.odoo.com/api/ping');
  });

  it('reuses a token that is still valid', async () => {
    vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(
      odooConfig({
        authToken: 'cached-token',
        tokenExpiry: new Date(Date.now() + 3_600_000),
      }) as never,
    );
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce({ data: { result: { success: true, data: {} } } }) as never;

    await odooCall('/api/ping');
    expect(vi.mocked(mockedAxios.post).mock.calls[0][0]).toBe('https://example.odoo.com/api/ping');
  });

  it('refreshes a token that expires within the minute', async () => {
    vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(
      odooConfig({
        authToken: 'about-to-expire',
        tokenExpiry: new Date(Date.now() + 30_000),
      }) as never,
    );
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk('renewed'))
      .mockResolvedValueOnce({ data: { result: { success: true, data: {} } } }) as never;

    await odooCall('/api/ping');
    expect(vi.mocked(mockedAxios.post).mock.calls[0][0]).toContain('/api/auth/login');
  });

  it('surfaces the Odoo error message when the call fails', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({
        data: { result: { success: false, message: 'Access denied by Odoo' } },
      }) as never;

    await expect(odooCall('/api/ping')).rejects.toThrow('Access denied by Odoo');
  });

  it('falls back to a generic error naming the path', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({ data: {} }) as never;

    await expect(odooCall('/api/ping')).rejects.toThrow(/\/api\/ping/);
  });

  it('fails when the base url is missing', async () => {
    vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(odooConfig({ baseUrl: '' }) as never);
    await expect(odooCall('/api/ping')).rejects.toThrow(/URL not configured/i);
  });

  it('fails when credentials are missing', async () => {
    vi.mocked(ensureOdooConfigFromEnv).mockResolvedValue(
      odooConfig({ login: '', password: '' }) as never,
    );
    await expect(odooCall('/api/ping')).rejects.toThrow(/credentials are required/i);
  });

  it('fails when login returns no token', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce({ data: { result: { success: true, data: {} } } }) as never;
    await expect(odooCall('/api/ping')).rejects.toThrow(/no token/i);
  });

  it('fails when login itself is rejected', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce({ data: { result: { success: false, message: 'bad password' } } }) as never;
    await expect(odooCall('/api/ping')).rejects.toThrow('bad password');
  });
});

describe('testOdooConnection', () => {
  it('reports success after a successful login', async () => {
    mockedAxios.post = vi.fn().mockResolvedValueOnce(loginOk()) as never;
    await expect(testOdooConnection()).resolves.toMatchObject({ ok: true });
  });

  it('reports the failure reason without throwing', async () => {
    mockedAxios.post = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as never;
    const result = await testOdooConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('odooFindEmployeeIdByCode', () => {
  it('returns null for a blank code without calling Odoo', async () => {
    mockedAxios.post = vi.fn() as never;
    await expect(odooFindEmployeeIdByCode('   ')).resolves.toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('prefers an exact code match over the first result', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({
        data: {
          result: {
            success: true,
            data: { items: [{ id: 11, code: 'E999' }, { id: 22, code: 'E1001' }] },
          },
        },
      }) as never;

    await expect(odooFindEmployeeIdByCode('E1001')).resolves.toBe(22);
  });

  it('falls back to the first result when no code matches exactly', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({
        data: { result: { success: true, data: { items: [{ id: 11, code: 'OTHER' }] } } },
      }) as never;

    await expect(odooFindEmployeeIdByCode('E1001')).resolves.toBe(11);
  });

  it('returns null and swallows a lookup failure', async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error('offline')) as never;
    await expect(odooFindEmployeeIdByCode('E1001')).resolves.toBeNull();
  });

  it('returns null when Odoo has no matching employee', async () => {
    mockedAxios.post = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({ data: { result: { success: true, data: { items: [] } } } }) as never;

    await expect(odooFindEmployeeIdByCode('E1001')).resolves.toBeNull();
  });
});
