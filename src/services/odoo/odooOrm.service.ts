/**
 * Standard Odoo JSON-RPC (/jsonrpc) for ORM access: authenticate + execute_kw.
 * Used for account.journal / account.account lookups and creating
 * biotime.deduction.loan.accounts.send. Complements the custom Flutter API client.
 */
import axios from 'axios';
import { prisma } from '../../prisma/client';
import { getCompanyId } from '../../tenant/context';
import { ensureOdooConfigFromEnv } from '../../bootstrap/odooConfig';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

type OdooSession = {
  baseUrl: string;
  database: string;
  uid: number;
  password: string;
};

async function loadConfig() {
  const companyId = getCompanyId();
  if (!companyId) {
    throw new Error('COMPANY_CONTEXT_REQUIRED:OdooConfig');
  }
  return ensureOdooConfigFromEnv(companyId);
}

async function jsonRpcCall<T>(
  baseUrl: string,
  params: { service: string; method: string; args: unknown[] },
): Promise<T> {
  const res = await axios.post(
    `${baseUrl}/jsonrpc`,
    { jsonrpc: '2.0', method: 'call', params, id: Date.now() },
    { timeout: 120000, headers: { 'Content-Type': 'application/json' } },
  );
  if (res.data?.error) {
    const err = res.data.error;
    const msg =
      err?.data?.message ||
      err?.message ||
      (typeof err === 'string' ? err : 'Odoo JSON-RPC error');
    throw new Error(String(msg));
  }
  return res.data?.result as T;
}

export async function authenticateOdooOrm(): Promise<OdooSession> {
  const config = await loadConfig();
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const database = config.database.trim();
  const login = config.login.trim();
  const password = config.password;
  if (!baseUrl || !database || !login || !password) {
    throw new Error('Odoo URL و Database و Login و Password مطلوبة');
  }

  const uid = await jsonRpcCall<number | false>(baseUrl, {
    service: 'common',
    method: 'authenticate',
    args: [database, login, password, {}],
  });
  if (typeof uid !== 'number' || uid <= 0) {
    throw new Error('فشل تسجيل الدخول إلى Odoo (authenticate)');
  }

  await prisma.odooConfig.update({
    where: { id: config.id },
    data: { isConnected: true },
  });

  return { baseUrl, database, uid, password };
}

export async function executeKw<T = unknown>(
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
  session?: OdooSession,
): Promise<T> {
  const s = session ?? (await authenticateOdooOrm());
  return jsonRpcCall<T>(s.baseUrl, {
    service: 'object',
    method: 'execute_kw',
    args: [s.database, s.uid, s.password, model, method, args, kwargs],
  });
}

export async function searchRead<T extends Record<string, unknown> = Record<string, unknown>>(
  model: string,
  domain: unknown[] = [],
  fields: string[] = [],
  opts: { limit?: number; offset?: number; order?: string } = {},
  session?: OdooSession,
): Promise<T[]> {
  return executeKw<T[]>(
    model,
    'search_read',
    [domain],
    {
      fields,
      limit: opts.limit ?? 200,
      offset: opts.offset ?? 0,
      ...(opts.order ? { order: opts.order } : {}),
    },
    session,
  );
}

/** Test via standard ORM authenticate (true/false for the Integration card). */
export async function testOdooOrmConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const session = await authenticateOdooOrm();
    return { ok: true, message: `Connected to Odoo (uid ${session.uid})` };
  } catch (err) {
    await prisma.odooConfig.updateMany({ data: { isConnected: false } });
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
  }
}
