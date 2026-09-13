import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import type { BioTimeConfig } from '@prisma/client';
import { BioTimeConnector } from '../../src/services/biotime/biotimeConnector.service';
import { prisma } from '../../src/prisma/client';

vi.mock('axios');
vi.mock('../../src/prisma/client', () => ({
  prisma: {
    bioTimeConfig: {
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  },
}));

const mockedAxios = vi.mocked(axios, true);

function config(overrides: Partial<BioTimeConfig> = {}): BioTimeConfig {
  return {
    id: 'cfg1',
    serverIp: '10.0.0.5',
    serverPort: 8082,
    useHttps: false,
    username: 'admin',
    password: 'admin',
    authType: 'jwt',
    authToken: null,
    tokenExpiry: null,
    isConnected: false,
    timezone: 'Africa/Cairo',
    ...overrides,
  } as BioTimeConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.mock('axios') also stubs isAxiosError, which the retry path depends on.
  mockedAxios.isAxiosError = ((err: unknown) =>
    Boolean(err && typeof err === 'object' && (err as { isAxiosError?: boolean }).isAxiosError)) as never;
});

/**
 * fromDb() is the only supported entry point: it is what authenticates.
 * A directly constructed connector deliberately holds no headers until
 * ensureAuth() runs via fromDb() or testConnection().
 */
async function connectorFrom(cfg: BioTimeConfig): Promise<BioTimeConnector> {
  vi.mocked(prisma.bioTimeConfig.findFirst).mockResolvedValue(cfg as never);
  return BioTimeConnector.fromDb();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BioTimeConnector', () => {
  it('builds an http base url from the configured host and port', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config());
    await connector.getDepartments();

    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as { url: string };
    expect(call.url).toContain('http://10.0.0.5:8082');
  });

  it('builds an https base url when configured', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config({ useHttps: true, serverPort: 443 }));
    await connector.getDepartments();

    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as { url: string };
    expect(call.url).toContain('https://10.0.0.5:443');
  });

  it('authenticates against the jwt endpoint and sends a JWT header', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'jwt-token' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config({ authType: 'jwt' }));
    await connector.getEmployees();

    const authUrl = vi.mocked(mockedAxios.post).mock.calls[0][0];
    expect(authUrl).toContain('/jwt-api-token-auth/');
    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe('JWT jwt-token');
  });

  it('uses the token endpoint and Token header for token auth', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'plain-token' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config({ authType: 'token' }));
    await connector.getEmployees();

    expect(vi.mocked(mockedAxios.post).mock.calls[0][0]).toContain('/api-token-auth/');
    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe('Token plain-token');
  });

  it('accepts an access or key token field', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { access: 'access-token' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config());
    await connector.getEmployees();
    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe('JWT access-token');
  });

  it('fails clearly when auth returns no token', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: {} })) as never;
    await expect(connectorFrom(config())).rejects.toThrow(/no token returned/i);
  });

  it('reuses a cached token that has not expired', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'fresh' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(
      config({ authToken: 'cached', tokenExpiry: new Date(Date.now() + 3_600_000) }),
    );
    await connector.getEmployees();

    expect(mockedAxios.post).not.toHaveBeenCalled();
    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe('JWT cached');
  });

  it('re-authenticates when the cached token has expired', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'renewed' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(
      config({ authToken: 'stale', tokenExpiry: new Date(Date.now() - 1000) }),
    );
    await connector.getEmployees();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('retries once after a 401 with a refreshed token', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'second' } })) as never;
    const unauthorized = Object.assign(new Error('unauthorized'), {
      isAxiosError: true,
      response: { status: 401 },
    });
    mockedAxios.request = vi
      .fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: { data: [{ id: 1 }] } }) as never;

    const connector = await connectorFrom(
      config({ authToken: 'first', tokenExpiry: new Date(Date.now() + 3_600_000) }),
    );
    const result = await connector.getEmployees();

    expect(vi.mocked(mockedAxios.request)).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(1);
  });

  it('propagates a non-401 failure', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    const serverError = Object.assign(new Error('boom'), {
      isAxiosError: true,
      response: { status: 500 },
    });
    mockedAxios.request = vi.fn().mockRejectedValue(serverError) as never;

    const connector = await connectorFrom(config());
    await expect(connector.getEmployees()).rejects.toThrow('boom');
    expect(vi.mocked(mockedAxios.request)).toHaveBeenCalledTimes(1);
  });

  it('allows a longer timeout for the transactions endpoint', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config());
    await connector.getTransactions();

    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as { timeout: number };
    expect(call.timeout).toBe(45_000);
  });

  it('passes paging and filters through to the API', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config());
    await connector.getTransactions(3, 250, { start_time: '2026-06-01 00:00:00' });

    const call = vi.mocked(mockedAxios.request).mock.calls[0][0] as {
      params: Record<string, unknown>;
    };
    expect(call.params).toMatchObject({
      page: 3,
      page_size: 250,
      start_time: '2026-06-01 00:00:00',
    });
  });

  it('fails when no BioTime configuration row exists', async () => {
    vi.mocked(prisma.bioTimeConfig.findFirst).mockResolvedValue(null as never);
    await expect(BioTimeConnector.fromDb()).rejects.toThrow(/configuration not found/i);
  });

  it('reports a healthy connection', async () => {
    mockedAxios.post = vi.fn(async () => ({ data: { token: 'tok' } })) as never;
    mockedAxios.request = vi.fn(async () => ({ data: { data: [] } })) as never;

    const connector = await connectorFrom(config());
    await expect(connector.testConnection()).resolves.toBe(true);
  });
});
