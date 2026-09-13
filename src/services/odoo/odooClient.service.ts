import axios from 'axios';
import { prisma } from '../../prisma/client';
import { getCompanyId } from '../../tenant/context';
import { logger } from '../../utils/logger';
import { ensureOdooConfigFromEnv } from '../../bootstrap/odooConfig';

export type OdooRpcResult = {
  success: boolean;
  message?: string;
  error_code?: string;
  data?: Record<string, unknown>;
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function getOdooConfig() {
  const companyId = getCompanyId();
  if (!companyId) {
    throw new Error('COMPANY_CONTEXT_REQUIRED:OdooConfig');
  }
  return ensureOdooConfigFromEnv(companyId);
}

export function odooConfigJson(config: Awaited<ReturnType<typeof getOdooConfig>>) {
  return {
    baseUrl: config.baseUrl,
    database: config.database,
    login: config.login,
    credentialsConfigured: Boolean(config.baseUrl && config.login && config.password),
    isConnected: config.isConnected,
    integrationEnabled: config.integrationEnabled === true,
    journalOdooId: config.journalOdooId ?? null,
    cashDebitAccountOdooId: config.cashDebitAccountOdooId ?? null,
    cashCreditAccountOdooId: config.cashCreditAccountOdooId ?? null,
    fawryDebitAccountOdooId: config.fawryDebitAccountOdooId ?? null,
    fawryCreditAccountOdooId: config.fawryCreditAccountOdooId ?? null,
    lastPushAt: config.lastPushAt?.toISOString() ?? null,
    tokenExpiry: config.tokenExpiry?.toISOString() ?? null,
  };
}

export async function updateOdooConfig(fields: {
  baseUrl?: string;
  database?: string;
  login?: string;
  password?: string;
  integrationEnabled?: boolean;
  journalOdooId?: number | null;
  cashDebitAccountOdooId?: number | null;
  cashCreditAccountOdooId?: number | null;
  fawryDebitAccountOdooId?: number | null;
  fawryCreditAccountOdooId?: number | null;
}) {
  const config = await getOdooConfig();
  const data: Record<string, unknown> = {};
  if (fields.baseUrl != null) data.baseUrl = normalizeBaseUrl(fields.baseUrl);
  if (fields.database != null) data.database = fields.database.trim();
  if (fields.login != null) data.login = fields.login.trim();
  if (fields.password != null && fields.password.length > 0) data.password = fields.password;
  if (fields.integrationEnabled != null) data.integrationEnabled = fields.integrationEnabled;
  if ('journalOdooId' in fields) data.journalOdooId = fields.journalOdooId;
  if ('cashDebitAccountOdooId' in fields) data.cashDebitAccountOdooId = fields.cashDebitAccountOdooId;
  if ('cashCreditAccountOdooId' in fields) {
    data.cashCreditAccountOdooId = fields.cashCreditAccountOdooId;
  }
  if ('fawryDebitAccountOdooId' in fields) data.fawryDebitAccountOdooId = fields.fawryDebitAccountOdooId;
  if ('fawryCreditAccountOdooId' in fields) {
    data.fawryCreditAccountOdooId = fields.fawryCreditAccountOdooId;
  }
  return prisma.odooConfig.update({ where: { id: config.id }, data });
}

async function refreshToken(config: Awaited<ReturnType<typeof getOdooConfig>>): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl || !config.login || !config.password) {
    throw new Error('Odoo URL and credentials are required');
  }

  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      login: config.login,
      password: config.password,
      db: config.database || undefined,
      device_info: 'Hudoori Node Push',
    },
    id: Date.now(),
  };

  const res = await axios.post(`${baseUrl}/api/auth/login`, body, {
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
  });

  const result = res.data?.result as OdooRpcResult | undefined;
  if (!result?.success) {
    throw new Error(result?.message ?? 'Odoo login failed');
  }

  const token = result.data?.token as string | undefined;
  if (!token) throw new Error('Odoo login returned no token');

  const expiryRaw = result.data?.expiry_date as string | undefined;
  const tokenExpiry = expiryRaw ? new Date(expiryRaw) : new Date(Date.now() + 29 * 86400000);

  await prisma.odooConfig.update({
    where: { id: config.id },
    data: { authToken: token, tokenExpiry, isConnected: true },
  });

  return token;
}

async function getToken(): Promise<{ baseUrl: string; token: string }> {
  const config = await getOdooConfig();
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new Error('Odoo URL not configured');

  let token = config.authToken;
  const expired = !config.tokenExpiry || config.tokenExpiry.getTime() < Date.now() + 60000;
  if (!token || expired) {
    token = await refreshToken(config);
  }
  return { baseUrl, token };
}

export async function testOdooConnection(): Promise<{ ok: boolean; message: string }> {
  // Prefer standard ORM authenticate so Integration settings work even when the
  // Flutter /api/auth/login bridge is unavailable; fall back to the token login.
  const { testOdooOrmConnection } = await import('./odooOrm.service');
  const orm = await testOdooOrmConnection();
  if (orm.ok) return orm;
  try {
    await refreshToken(await getOdooConfig());
    return { ok: true, message: 'Connected to Odoo (API token)' };
  } catch (err) {
    await prisma.odooConfig.updateMany({ data: { isConnected: false } });
    return {
      ok: false,
      message:
        orm.message ||
        (err instanceof Error ? err.message : 'Connection failed'),
    };
  }
}

export async function odooCall<T = Record<string, unknown>>(
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const { baseUrl, token } = await getToken();
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: { token, ...params },
    id: Date.now(),
  };

  const res = await axios.post(`${baseUrl}${path}`, body, {
    timeout: 120000,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });

  const result = res.data?.result as OdooRpcResult | undefined;
  if (!result?.success) {
    throw new Error(result?.message ?? `Odoo API error on ${path}`);
  }
  return (result.data ?? {}) as T;
}

export async function odooFindEmployeeIdByCode(empCode: string): Promise<number | null> {
  if (!empCode.trim()) return null;
  try {
    const data = await odooCall<{ employees?: { id: number }[]; items?: { id: number }[] }>(
      '/api/biotime/employees/list',
      { search: empCode.trim(), limit: 5 },
    );
    const list = (data.items ?? data.employees ?? []) as { id: number; code?: string }[];
    const exact = list.find((e) => String(e.code ?? '') === empCode.trim());
    const pick = exact ?? list[0];
    return pick?.id ?? null;
  } catch (err) {
    logger.warn({ err, empCode }, 'Odoo employee lookup failed');
    return null;
  }
}
